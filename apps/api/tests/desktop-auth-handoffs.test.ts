import { describe, expect, it } from "vitest";
import {
  createDesktopAuthHandoffStore,
  DESKTOP_AUTH_HANDOFF_TTL_MS,
  isValidDesktopAuthHandoffId
} from "../src/desktop-auth-handoffs.js";

const entry = { token: "session-token", user: { id: "user:a", email: "a@space.local", role: "USER" } };
const validId = "0123456789abcdef0123456789abcdef";

describe("desktop auth handoffs", () => {
  it("accepts only opaque ids of a bounded length and charset", () => {
    expect(isValidDesktopAuthHandoffId(validId)).toBe(true);
    expect(isValidDesktopAuthHandoffId("short")).toBe(false);
    expect(isValidDesktopAuthHandoffId("has spaces and ; separators")).toBe(false);
    expect(isValidDesktopAuthHandoffId("x".repeat(129))).toBe(false);
    expect(isValidDesktopAuthHandoffId(undefined)).toBe(false);
    expect(isValidDesktopAuthHandoffId(42)).toBe(false);
  });

  it("hands the session out exactly once", () => {
    const store = createDesktopAuthHandoffStore({ now: () => 1_000 });
    store.store(validId, entry);
    expect(store.take(validId)?.token).toBe("session-token");
    expect(store.take(validId)).toBeNull();
  });

  it("expires unclaimed sign-ins after the handoff window", () => {
    let clock = 1_000;
    const store = createDesktopAuthHandoffStore({ now: () => clock });
    store.store(validId, entry);
    clock += DESKTOP_AUTH_HANDOFF_TTL_MS + 1;
    expect(store.take(validId)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("stays bounded by evicting the oldest entry", () => {
    let clock = 1_000;
    const store = createDesktopAuthHandoffStore({ now: () => clock++, maxEntries: 2 });
    store.store(`${validId}1`, entry);
    store.store(`${validId}2`, entry);
    store.store(`${validId}3`, entry);
    expect(store.size).toBe(2);
    expect(store.take(`${validId}1`)).toBeNull();
    expect(store.take(`${validId}3`)).not.toBeNull();
  });

  it("rejects malformed ids at storage time", () => {
    const store = createDesktopAuthHandoffStore();
    expect(() => store.store("bad id", entry)).toThrow();
  });
});
