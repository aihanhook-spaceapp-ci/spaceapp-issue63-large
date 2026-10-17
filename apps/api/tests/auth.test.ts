import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authenticateLogin,
  generatePkcePair,
  getAuthConfig,
  hashPassword,
  SessionRevocationStore,
  signOAuthState,
  signSession,
  signSessionWithTtl,
  verifyOAuthState,
  verifyPassword,
  verifyPkce,
  verifySession
} from "../src/auth.js";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET } from "../src/antigravity-usage-services.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Space auth", () => {
  it("allows the explicit dev login only outside production", () => {
    expect(getAuthConfig({
      NODE_ENV: "test",
      SPACE_DEV_LOGIN: "true"
    }).devLogin).toBe(true);
    expect(getAuthConfig({
      NODE_ENV: "production",
      SPACE_DEV_LOGIN: "true"
    }).devLogin).toBe(false);
  });

  it("hashes and verifies production operator passwords with the configured scrypt cost", async () => {
    const encoded = await hashPassword("operator-password-test");

    expect(encoded).toMatch(/^scrypt\$32768\$8\$1\$/);
    await expect(verifyPassword("operator-password-test", encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", encoded)).resolves.toBe(false);
    await expect(
      authenticateLogin(
        { email: "operator@space.test", password: "operator-password-test" },
        {
          sessionSecret: "test-secret-with-enough-length",
          devLogin: false,
          secureCookies: false,
          operatorEmail: "operator@space.test",
          operatorPasswordHash: encoded
        }
      )
    ).resolves.toMatchObject({ id: "user:operator", role: "ADMIN" });
  });

  it("signs proof sessions with a bounded explicit TTL", () => {
    const secret = "test-secret-with-enough-length";
    const token = signSessionWithTtl({ id: "user:proof", email: "proof@space.test", role: "ADMIN" }, secret, 600);
    expect(verifySession(token, secret)).toMatchObject({ id: "user:proof" });
    expect(() => signSessionWithTtl({ id: "user:proof", email: "proof@space.test", role: "ADMIN" }, secret, 43_201)).toThrow();
  });

  it("keeps the operator session valid until the 400-day boundary", () => {
    vi.useFakeTimers();
    const issuedAt = Date.parse("2026-07-20T06:00:00.000Z");
    const ttlMs = 400 * 24 * 60 * 60 * 1000;
    vi.setSystemTime(issuedAt);
    const secret = "test-secret-with-enough-length";
    const token = signSession({ id: "user:operator", email: "operator@space.test", role: "ADMIN" }, secret);

    vi.setSystemTime(issuedAt + ttlMs - 1_000);
    expect(verifySession(token, secret)).toMatchObject({ id: "user:operator" });
    vi.setSystemTime(issuedAt + ttlMs);
    expect(verifySession(token, secret)).toBeNull();
  });

  it("does not issue persistent sessions to the proof operator", () => {
    expect(() =>
      signSession(
        { id: "user:operator-proof", email: "operator@space.test", role: "ADMIN" },
        "test-secret-with-enough-length"
      )
    ).toThrow("Proof operators cannot receive persistent sessions.");
  });

  it("uses the shared Antigravity Google OAuth client only when explicitly opted in", () => {
    const defaultConfig = getAuthConfig({});
    expect(defaultConfig.googleClientId).toBeFalsy();
    expect(defaultConfig.googleClientSecret).toBeFalsy();

    const sharedConfig = getAuthConfig({ SPACE_GOOGLE_SHARED_CLIENT: "true" });
    expect(sharedConfig.googleClientId).toBe(ANTIGRAVITY_CLIENT_ID);
    expect(sharedConfig.googleClientSecret).toBe(ANTIGRAVITY_CLIENT_SECRET);

    const disabledConfig = getAuthConfig({ SPACE_GOOGLE_AUTH_DISABLED: "true" });
    expect(disabledConfig.googleClientId).toBeUndefined();
    expect(disabledConfig.googleClientSecret).toBeUndefined();

    const customConfig = getAuthConfig({
      SPACE_GOOGLE_CLIENT_ID: "custom-client-id",
      SPACE_GOOGLE_CLIENT_SECRET: "custom-client-secret"
    });
    expect(customConfig.googleClientId).toBe("custom-client-id");
    expect(customConfig.googleClientSecret).toBe("custom-client-secret");
  });

  it("cryptographically signs and verifies OAuth state parameters", () => {
    const secret = "test-secret-with-enough-length";
    const rawState = "random-state-1234567890abcdef";
    const signed = signOAuthState(rawState, secret);
    expect(signed).toContain(".");
    expect(verifyOAuthState(signed, secret)).toBe(rawState);
  });

  it("rejects tampered or forged OAuth state", () => {
    const secret = "test-secret-with-enough-length";
    const signed = signOAuthState("state1", secret);
    const tampered = signed.replace("state1", "state2");
    expect(verifyOAuthState(tampered, secret)).toBeNull();
    expect(verifyOAuthState("un-signed-state", secret)).toBeNull();
    expect(verifyOAuthState("", secret)).toBeNull();
  });

  it("rejects session tokens with malformed or non-numeric expiration", () => {
    const secret = "test-secret-with-enough-length";
    const malformedPayload = { user: { id: "user:test", email: "test@example.com", role: "USER" }, exp: "never" };
    const body = Buffer.from(JSON.stringify(malformedPayload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    expect(verifySession(`${body}.${sig}`, secret)).toBeNull();
  });

  it("generates and verifies RFC 7636 compliant PKCE code_verifier and code_challenge pairs", () => {
    const pkce = generatePkcePair();
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.codeChallenge.length).toBeGreaterThanOrEqual(43);
    expect(verifyPkce(pkce.codeVerifier, pkce.codeChallenge)).toBe(true);
    expect(verifyPkce("tampered-verifier", pkce.codeChallenge)).toBe(false);
    expect(verifyPkce(pkce.codeVerifier, "tampered-challenge")).toBe(false);
    expect(verifyPkce("", pkce.codeChallenge)).toBe(false);
  });

  it("revokes sessions immediately through SessionRevocationStore and rejects revoked tokens", () => {
    const secret = "test-secret-with-enough-length";
    const revocation = new SessionRevocationStore();
    try {
      const user = { id: "user:revokable", email: "revokable@space.test", role: "ADMIN" as const };
      const token1 = signSessionWithTtl(user, secret, 3600);
      const token2 = signSessionWithTtl(user, secret, 7200);

      expect(verifySession(token1, secret, revocation)).toMatchObject({ id: "user:revokable" });
      expect(verifySession(token2, secret, revocation)).toMatchObject({ id: "user:revokable" });

      // Revoke token1
      revocation.revokeToken(token1);
      expect(verifySession(token1, secret, revocation)).toBeNull();
      expect(verifySession(token2, secret, revocation)).toMatchObject({ id: "user:revokable" });

      // Revoke all existing user sessions
      revocation.revokeUser(user.id);
      expect(verifySession(token2, secret, revocation)).toBeNull();

      // New token issued after user revocation epoch is accepted
      const token3 = signSessionWithTtl(user, secret, 3600, Date.now() + 5000);
      expect(verifySession(token3, secret, revocation)).toMatchObject({ id: "user:revokable" });
    } finally {
      revocation.close();
    }
  });
});
