import { Writable } from "node:stream";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { apiLogRedaction } from "../src/request-logging.js";

it("redacts credentials in structured API log objects", async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, callback) { lines.push(String(chunk)); callback(); } });
  const app = Fastify({ logger: { level: "info", redact: apiLogRedaction, stream } });
  await app.ready();
  app.log.info({
    password: "top-level-password",
    token: "top-level-token",
    body: { password: "body-password", apiKey: "body-api-key", note: "kept" },
    err: { config: { headers: { authorization: "Bearer upstream-token" } } },
    provider: { credentials: { secret: "nested-secret", token: "nested-token" }, accessToken: "access-token" },
    session: { refreshToken: "refresh-token", clientSecret: "client-secret", userId: "user:visible" }
  }, "credential redaction probe");
  await app.close();
  const output = lines.join("");
  for (const secret of ["top-level-password", "top-level-token", "body-password", "body-api-key", "upstream-token",
    "nested-secret", "nested-token", "access-token", "refresh-token", "client-secret"]) {
    expect(output, secret).not.toContain(secret);
  }
  expect(output).toContain("[REDACTED]");
  expect(output).toContain("kept");
  expect(output).toContain("user:visible");
});
