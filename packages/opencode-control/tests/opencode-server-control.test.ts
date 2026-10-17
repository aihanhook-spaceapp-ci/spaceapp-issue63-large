import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  OpenCodeSilentStopRecovery,
  fetchOpenCodeCurrentModel,
  fetchOpenCodeSessionIsTurnActive,
  fetchOpenCodeSessionModels,
  fetchOpenCodeSessionTitle,
  openCodeServerBaseUrl,
  openCodeServerIsHealthy,
  openCodeSharedServerHost,
  opencodeServerControlPath,
  isOpenCodeZeroTokenUnknownCompletion,
  parseOpenCodeCompositeModelId,
  readOpenCodeServerControl,
  readOpenCodeServerControlFromMapping,
  resolveOpenCodeTitleFallbackControl,
  switchOpenCodeSessionModel,
  updateOpenCodeSessionTitle,
  type OpenCodeServerControl
} from "../src/index.js";

const username = "space-opencode";
const password = "test-password";
const controlFixture: OpenCodeServerControl = {
  version: 1,
  spaceSessionId: "cli_session:opencode-test",
  nativeSessionId: "ses_abc123",
  serverPort: 0,
  serverUsername: username,
  serverPassword: password,
  updatedAt: "2026-08-03T00:00:00.000Z"
};

describe("parseOpenCodeCompositeModelId", () => {
  it("splits a composite provider/model id on the first separator", () => {
    expect(parseOpenCodeCompositeModelId("opencode/deepseek-v4-flash-free")).toEqual({
      providerId: "opencode",
      modelId: "deepseek-v4-flash-free"
    });
    expect(parseOpenCodeCompositeModelId("openrouter/accounts/foo/bar")).toEqual({
      providerId: "openrouter",
      modelId: "accounts/foo/bar"
    });
  });

  it("rejects malformed composite ids", () => {
    expect(parseOpenCodeCompositeModelId("no-separator")).toBeNull();
    expect(parseOpenCodeCompositeModelId("/empty-provider")).toBeNull();
    expect(parseOpenCodeCompositeModelId("empty-model/")).toBeNull();
    expect(parseOpenCodeCompositeModelId("")).toBeNull();
  });
});

describe("readOpenCodeServerControl", () => {
  let tempRoot: string;
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-control-"));
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    await mkdir(controlDir, { recursive: true, mode: 0o710 });
    const controlPath = join(controlDir, "cli_session_opencode-test.json");
    await writeFile(
      controlPath,
      `${JSON.stringify({ ...controlFixture, serverPort: 43210 })}\n`,
      { encoding: "utf8", mode: 0o640 }
    );
    await chmod(controlPath, 0o640);
  });
  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("reads a valid control file", async () => {
    const control = await readOpenCodeServerControl("cli_session:opencode-test", tempRoot);
    expect(control).not.toBeNull();
    expect(control?.nativeSessionId).toBe("ses_abc123");
    expect(control?.serverPort).toBe(43210);
    expect(control?.serverUsername).toBe(username);
    expect(control?.serverPassword).toBe(password);
  });

  it("returns null when the control file is missing", async () => {
    expect(await readOpenCodeServerControl("cli_session:missing", tempRoot)).toBeNull();
  });

  it("returns null for a control file with a mismatched space session id", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    const badPath = join(controlDir, "cli_session_wrong.json");
    await writeFile(badPath, JSON.stringify({ ...controlFixture, spaceSessionId: "cli_session:other", serverPort: 43211 }), {
      encoding: "utf8",
      mode: 0o640
    });
    expect(await readOpenCodeServerControl("cli_session:opencode-test", tempRoot)).not.toBeNull();
    expect(await readOpenCodeServerControl("cli_session:wrong", tempRoot)).toBeNull();
    await rm(badPath, { force: true });
  });

  it("returns null for malformed control payloads", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    const badPath = join(controlDir, "cli_session_malformed.json");
    await writeFile(badPath, "{not-json", { encoding: "utf8", mode: 0o640 });
    expect(await readOpenCodeServerControl("cli_session:malformed", tempRoot)).toBeNull();
    await rm(badPath, { force: true });
  });

  it("reads a control file with an explicit serverHost", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    const hostPath = join(controlDir, "cli_session_hosted.json");
    await writeFile(
      hostPath,
      `${JSON.stringify({ ...controlFixture, spaceSessionId: "cli_session:hosted", serverHost: "10.254.240.13", serverPort: 43212 })}\n`,
      { encoding: "utf8", mode: 0o640 }
    );
    const control = await readOpenCodeServerControl("cli_session:hosted", tempRoot);
    expect(control?.serverHost).toBe("10.254.240.13");
    await rm(hostPath, { force: true });
  });

  it("substitutes loopback server hosts with the opencode shared bridge address", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    for (const [spaceSessionId, loopbackHost] of [
      ["cli_session:loopback4", "127.0.0.1"],
      ["cli_session:loopbackname", "localhost"]
    ] as const) {
      const path = join(controlDir, `${spaceSessionId.replace(/:/g, "_")}.json`);
      await writeFile(
        path,
        `${JSON.stringify({ ...controlFixture, spaceSessionId, serverHost: loopbackHost, serverPort: 43213 })}\n`,
        { encoding: "utf8", mode: 0o640 }
      );
      const control = await readOpenCodeServerControl(spaceSessionId, tempRoot);
      expect(control?.serverHost).toBe(openCodeSharedServerHost);
      await rm(path, { force: true });
    }
  });

  it("keeps a loopback host recorded by a launcher that runs in the host network", async () => {
    const controlDir = join(tempRoot, "opencode", "space-cli-control");
    const path = join(controlDir, "cli_session_hostnet.json");
    await writeFile(
      path,
      `${JSON.stringify({ ...controlFixture, spaceSessionId: "cli_session:hostnet", serverHost: "127.0.0.1", serverNetwork: "host", serverPort: 43214 })}\n`,
      { encoding: "utf8", mode: 0o640 }
    );
    const control = await readOpenCodeServerControl("cli_session:hostnet", tempRoot);
    expect(control?.serverHost).toBe("127.0.0.1");
    await rm(path, { force: true });
  });
});

describe("readOpenCodeServerControlFromMapping", () => {
  it("resolves control from persistent mapping file and shared env", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-mapping-"));
    try {
      const mappingDir = join(tempRoot, "opencode", "space-cli-sessions");
      const opencodeDir = join(tempRoot, "opencode");
      await mkdir(mappingDir, { recursive: true, mode: 0o710 });
      const envPath = join(opencodeDir, "space-shared-server.env");
      await writeFile(envPath, `OPENCODE_SERVER_USERNAME=shared-user\nOPENCODE_SERVER_PASSWORD=shared-pass\n`, {
        encoding: "utf8",
        mode: 0o640
      });
      const mappingPath = join(mappingDir, "cli_session_test.json");
      await writeFile(
        mappingPath,
        JSON.stringify({
          version: 1,
          spaceSessionId: "cli_session:test",
          nativeSessionId: "ses_persisted123",
          updatedAt: "2026-10-06T08:00:00.000Z"
        }),
        { encoding: "utf8", mode: 0o640 }
      );

      const control = await readOpenCodeServerControlFromMapping("cli_session:test", tempRoot);
      expect(control).not.toBeNull();
      expect(control?.nativeSessionId).toBe("ses_persisted123");
      expect(control?.spaceSessionId).toBe("cli_session:test");
      expect(control?.serverUsername).toBe("shared-user");
      expect(control?.serverPassword).toBe("shared-pass");
      expect(control?.serverPort).toBe(47047);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns null when mapping file does not exist", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-mapping-"));
    try {
      expect(await readOpenCodeServerControlFromMapping("cli_session:nonexistent", tempRoot)).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveOpenCodeTitleFallbackControl", () => {
  it("returns the most recent live control when one exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-fallback-"));
    try {
      const controlDir = join(tempRoot, "opencode", "space-cli-control");
      await mkdir(controlDir, { recursive: true, mode: 0o710 });
      const controlPath = join(controlDir, "cli_session_live.json");
      await writeFile(
        controlPath,
        `${JSON.stringify({ ...controlFixture, spaceSessionId: "cli_session:live", serverHost: "127.0.0.1", serverPort: 47047 })}\n`,
        { encoding: "utf8", mode: 0o640 }
      );
      const control = await resolveOpenCodeTitleFallbackControl(tempRoot);
      expect(control).not.toBeNull();
      expect(control?.spaceSessionId).toBe("cli_session:live");
      expect(control?.serverHost).toBe(openCodeSharedServerHost);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("builds a control from the shared server env file when no live control exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-fallback-env-"));
    try {
      const opencodeDir = join(tempRoot, "opencode");
      await mkdir(opencodeDir, { recursive: true, mode: 0o750 });
      const envPath = join(opencodeDir, "space-shared-server.env");
      await writeFile(
        envPath,
        `SPACE_OPENCODE_SHARED=1\nOPENCODE_SERVER_USERNAME=shared-user\nOPENCODE_SERVER_PASSWORD=shared-pass\n`,
        { encoding: "utf8", mode: 0o640 }
      );
      const control = await resolveOpenCodeTitleFallbackControl(tempRoot);
      expect(control).not.toBeNull();
      expect(control?.spaceSessionId).toBe("space-shared");
      expect(control?.nativeSessionId).toBe("");
      expect(control?.serverPort).toBe(47047);
      expect(control?.serverHost).toBe(openCodeSharedServerHost);
      expect(control?.serverUsername).toBe("shared-user");
      expect(control?.serverPassword).toBe("shared-pass");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns null when there is no control and no shared env file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "space-opencode-fallback-empty-"));
    try {
      expect(await resolveOpenCodeTitleFallbackControl(tempRoot)).toBeNull();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

const zeroTokenUnknown = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_empty_first",
  sessionID: "ses_abc123",
  parentID: "msg_user_turn",
  role: "assistant",
  finish: "unknown",
  time: { created: 1786000000000, completed: 1786000000100 },
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 }
  },
  ...overrides
});

const messageUpdated = (info: Record<string, unknown>) => ({
  type: "message.updated",
  properties: { info }
});

describe("OpenCode zero-token unknown recovery", () => {
  it("detects only a completed, error-free, zero-token unknown assistant response", () => {
    expect(isOpenCodeZeroTokenUnknownCompletion(zeroTokenUnknown())).toBe(true);
    expect(isOpenCodeZeroTokenUnknownCompletion(zeroTokenUnknown({ finish: "stop" }))).toBe(false);
    expect(isOpenCodeZeroTokenUnknownCompletion(zeroTokenUnknown({ tokens: {
      input: 1,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 }
    } }))).toBe(false);
    expect(isOpenCodeZeroTokenUnknownCompletion(zeroTokenUnknown({ time: { created: 1786000000000 } }))).toBe(false);
  });

  it("ignores successful completions and explicit operator aborts", async () => {
    const fetchImpl = vi.fn();
    const recovery = new OpenCodeSilentStopRecovery({
      control: { ...controlFixture, serverPort: 43210 },
      directory: "/etc",
      fetchImpl: fetchImpl as typeof fetch
    });
    const success = await recovery.handleEvent(messageUpdated(zeroTokenUnknown({
      finish: "stop",
      tokens: { input: 12, output: 4, reasoning: 0, cache: { read: 8, write: 0 } }
    })));
    const explicitStop = await recovery.handleEvent(messageUpdated(zeroTokenUnknown({
      error: { name: "MessageAbortedError", data: { message: "Aborted" } }
    })));
    expect(success.outcome).toBe("ignored");
    expect(explicitStop.outcome).toBe("ignored");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resumes the same user turn while preserving completed tool history", async () => {
    const failed = zeroTokenUnknown();
    const parent = {
      info: {
        id: "msg_user_turn",
        sessionID: "ses_abc123",
        role: "user",
        agent: "build",
        model: { providerID: "opencode", modelID: "deepseek-v4-flash-free", variant: "max" }
      },
      parts: [{
        id: "prt_original_prompt",
        sessionID: "ses_abc123",
        messageID: "msg_user_turn",
        type: "text",
        text: "Implement the requested change."
      }]
    };
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    let statusCalls = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ method, path: `${url.pathname}${url.search}`, body });
      if (url.pathname === "/session/status") {
        statusCalls += 1;
        return Response.json({ ses_abc123: { type: statusCalls === 1 ? "busy" : "idle" } });
      }
      if (url.pathname === "/session/ses_abc123/message" && url.searchParams.get("limit") === "1") {
        return Response.json([{ info: failed, parts: [{ type: "step-start" }, { type: "step-finish" }] }]);
      }
      if (url.pathname === "/session/ses_abc123/message/msg_user_turn") return Response.json(parent);
      if (url.pathname === "/session/ses_abc123/message/msg_empty_first" && method === "DELETE") {
        return Response.json(true);
      }
      if (url.pathname === "/session/ses_abc123/prompt_async" && method === "POST") {
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const sleep = vi.fn(async () => undefined);
    const recovery = new OpenCodeSilentStopRecovery({
      control: { ...controlFixture, serverPort: 43210 },
      directory: "/etc",
      fetchImpl: fetchImpl as typeof fetch,
      sleep
    });

    await expect(recovery.handleEvent(messageUpdated(failed))).resolves.toMatchObject({ outcome: "recovered" });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/session/ses_abc123/message/msg_empty_first?directory=%2Fetc"
    ]);
    const resume = calls.find((call) => call.path.startsWith("/session/ses_abc123/prompt_async"));
    expect(resume?.body).toEqual({
      messageID: "msg_user_turn",
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      agent: "build",
      variant: "max",
      parts: [{ id: "prt_original_prompt", type: "text", text: "Implement the requested change." }]
    });
    expect(calls.some((call) => call.path.includes("tool"))).toBe(false);
  });

  it("allows only one automatic retry per user turn and adds a visible failure part", async () => {
    const first = zeroTokenUnknown();
    const second = zeroTokenUnknown({ id: "msg_empty_second" });
    let latest = first;
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === "/session/status") return Response.json({ ses_abc123: { type: "idle" } });
      if (url.pathname === "/session/ses_abc123/message" && url.searchParams.get("limit") === "1") {
        return Response.json([{ info: latest, parts: [] }]);
      }
      if (url.pathname === "/session/ses_abc123/message/msg_user_turn") {
        return Response.json({
          info: {
            id: "msg_user_turn",
            role: "user",
            agent: "build",
            model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" }
          },
          parts: [{ id: "prt_prompt", sessionID: "ses_abc123", messageID: "msg_user_turn", type: "text", text: "go" }]
        });
      }
      if (method === "DELETE") return Response.json(true);
      if (url.pathname === "/session/ses_abc123/prompt_async") return new Response(null, { status: 204 });
      if (method === "PATCH" && url.pathname.includes("/part/prt_space_recovery_")) {
        return Response.json(body);
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const recovery = new OpenCodeSilentStopRecovery({
      control: { ...controlFixture, serverPort: 43210 },
      directory: "/etc",
      fetchImpl: fetchImpl as typeof fetch
    });

    expect((await recovery.handleEvent(messageUpdated(first))).outcome).toBe("recovered");
    latest = second;
    expect((await recovery.handleEvent(messageUpdated(second))).outcome).toBe("exhausted");
    expect(calls.filter((call) => call.path === "/session/ses_abc123/prompt_async")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    const notice = calls.find((call) => call.method === "PATCH");
    expect(notice?.body).toMatchObject({
      sessionID: "ses_abc123",
      messageID: "msg_empty_second",
      type: "text"
    });
    expect(String(notice?.body?.text)).toContain("single automatic retry");
  });
});

describe("opencode server HTTP client", () => {
  const requestedPaths: Array<{ method: string; path: string; auth?: string; body?: Record<string, unknown> }> = [];
  let port = 0;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const auth = request.headers.authorization;
      let rawBody = "";
      request.on("data", (chunk) => {
        rawBody += String(chunk);
      });
      request.on("end", () => {
        let body: Record<string, unknown> | undefined;
        if (rawBody.length > 0) {
          try {
            body = JSON.parse(rawBody) as Record<string, unknown>;
          } catch {
            body = undefined;
          }
        }
        requestedPaths.push({ method: request.method ?? "GET", path: url.pathname, search: url.search, auth, body });
        if (url.pathname === '/config/providers' && url.searchParams.get('directory') === '/native-fixture') {
          response.writeHead(200, {'content-type':'application/json'});
          response.end(JSON.stringify({providers:[{id:'opencode',models:{'muse-spark-free':{
            id:'muse-spark-free',name:'Muse Spark Free',variants:{low:{reasoningEffort:'low'},xhigh:{reasoningEffort:'xhigh'}}
          }}}]}));
          return;
        }
        if (url.pathname === "/global/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ healthy: true, version: "test" }));
          return;
        }
        if (url.pathname === "/api/model") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            location: { directory: "/etc" },
            data: [
              { id: "deepseek-v4-flash-free", providerID: "opencode", name: "DeepSeek V4 Flash Free", status: "active", enabled: true },
              { id: "kimi-k3", providerID: "legacy", name: "Kimi K3", status: "active", enabled: true,
                variants: [{id:'low',body:{reasoningEffort:'low'}},{id:'high',body:{reasoningEffort:'high'}},{id:'high'},null,{}],request:{variant:'high'} },
              { id: "old-model-free", providerID: "opencode", name: "Old Free", status: "deprecated", enabled: true },
              { id: "disabled-model", providerID: "opencode", name: "Disabled", status: "active", enabled: false }
            ]
          }));
          return;
        }
        if (url.pathname === '/api/session/ses_modern') {
          response.writeHead(200, {'content-type':'application/json'});
          response.end(JSON.stringify({data:{model:{id:'kimi-k3',providerID:'legacy',variant:'high'}}}));
          return;
        }
        if (url.pathname === "/session/status") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            ses_abc123: { type: "busy" },
            ses_other: { type: "idle" }
          }));
          return;
        }
        if (url.pathname === "/session/ses_abc123") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            id: "ses_abc123",
            title: "Session title test",
            time: { updated: 1786000000000 },
            model: { id: "kimi-k3", providerID: "legacy", variant: null }
          }));
          return;
        }
        if (url.pathname === "/session/ses_title_unknown") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            id: "ses_title_unknown",
            title: "",
            time: { updated: 1786000000000 }
          }));
          return;
        }
        if (url.pathname === "/session/ses_abc123" && request.method === "PATCH") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            id: "ses_abc123",
            title: body?.title ?? "",
            time: { updated: 1786000001000 }
          }));
          return;
        }
        if (url.pathname === "/api/session/ses_abc123/model" && request.method === "POST") {
          response.writeHead(204);
          response.end();
          return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    port = address.port;
    controlFixture.serverPort = port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("builds the base URL from the control port and host", () => {
    expect(openCodeServerBaseUrl(43210)).toBe("http://127.0.0.1:43210");
    expect(openCodeServerBaseUrl(43210, "10.254.240.13")).toBe("http://10.254.240.13:43210");
  });

  it("reports healthy against the live endpoint", async () => {
    expect(await openCodeServerIsHealthy(controlFixture)).toBe(true);
  });

  it("fetches active enabled models into descriptors", async () => {
    const models = await fetchOpenCodeSessionModels(controlFixture);
    const ids = models.map((model) => `${model.providerId}/${model.modelId}`);
    expect(ids).toEqual([
      "opencode/deepseek-v4-flash-free",
      "legacy/kimi-k3"
    ]);
    expect(models[0]?.displayName).toBe("DeepSeek V4 Flash Free");
    expect(models[1]).toMatchObject({variants:['low','high'],defaultVariant:'high'});
  });

  it('uses the configured native TUI catalog and preserves its provider, free label and reasoning variants',async()=>{
    expect(await fetchOpenCodeSessionModels(controlFixture,'/native-fixture')).toEqual([
      {providerId:'opencode',providerName:'opencode',modelId:'muse-spark-free',displayName:'Muse Spark Free',variants:['low','xhigh'],defaultVariant:null}
    ]);
  });

  it("reads the current session model", async () => {
    const model = await fetchOpenCodeCurrentModel(controlFixture, "ses_abc123");
    expect(model).toEqual({ id: "kimi-k3", providerID: "legacy", variant: null });
    expect(await fetchOpenCodeCurrentModel(controlFixture, "ses_unknown")).toBeNull();
  });

  it('reads the current native API session model and reasoning variant',async()=>{
    expect(await fetchOpenCodeCurrentModel(controlFixture,'ses_modern')).toEqual({id:'kimi-k3',providerID:'legacy',variant:'high'});
  });

  it("reads the current session title and updated timestamp", async () => {
    const info = await fetchOpenCodeSessionTitle(controlFixture, "ses_abc123");
    expect(info).toEqual({ title: "Session title test", updatedAt: 1786000000000 });
  });

  it("returns null when the session has no title", async () => {
    expect(await fetchOpenCodeSessionTitle(controlFixture, "ses_title_unknown")).toBeNull();
    expect(await fetchOpenCodeSessionTitle(controlFixture, "ses_unknown")).toBeNull();
  });

  it("updates the session title over HTTP", async () => {
    await expect(
      updateOpenCodeSessionTitle(controlFixture, "ses_abc123", "New pane title")
    ).resolves.toBeUndefined();
    const updateCall = requestedPaths.find((entry) => entry.path === "/session/ses_abc123" && entry.method === "PATCH");
    expect(updateCall?.body).toEqual({ title: "New pane title" });
    expect(updateCall?.auth).toBe(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  });

  it("rejects a title update when the server errors", async () => {
    await expect(
      updateOpenCodeSessionTitle(controlFixture, "ses_unknown", "New pane title")
    ).rejects.toThrow(/HTTP 404/);
  });

  it("reads whether the session turn is active", async () => {
    expect(await fetchOpenCodeSessionIsTurnActive(controlFixture, "ses_abc123")).toBe(true);
    expect(await fetchOpenCodeSessionIsTurnActive(controlFixture, "ses_other")).toBe(false);
    expect(await fetchOpenCodeSessionIsTurnActive(controlFixture, "ses_unknown")).toBe(false);
  });

  it("passes directory query parameter when reading turn active status", async () => {
    const ctrl = { ...controlFixture, directory: "/etc" };
    expect(await fetchOpenCodeSessionIsTurnActive(ctrl, "ses_abc123")).toBe(true);
    const statusCalls = requestedPaths.filter((entry) => entry.path === "/session/status");
    expect(statusCalls.some((call: any) => call.search === "?directory=%2Fetc")).toBe(true);
  });

  it("switches the session model over HTTP", async () => {
    await expect(
      switchOpenCodeSessionModel(controlFixture, "ses_abc123", "opencode", "deepseek-v4-flash-free")
    ).resolves.toBeUndefined();
    const switchCall = requestedPaths.find((entry) => entry.path === "/api/session/ses_abc123/model");
    expect(switchCall?.method).toBe("POST");
    expect(switchCall?.auth).toBe(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  });

  it("passes the reasoning effort as the model variant when it is advertised", async () => {
    await expect(
      switchOpenCodeSessionModel(controlFixture, "ses_abc123", "legacy", "kimi-k3", "high", ["low", "medium", "high"])
    ).resolves.toBeUndefined();
    const switchCalls = requestedPaths.filter((entry) => entry.path === "/api/session/ses_abc123/model");
    expect(switchCalls.at(-1)?.body).toMatchObject({ model: { id: "kimi-k3", providerID: "legacy", variant: "high" } });
  });

  it("passes the default reasoning effort as an explicit variant so it round-trips", async () => {
    await expect(
      switchOpenCodeSessionModel(controlFixture, "ses_abc123", "legacy", "kimi-k3", "default", ["low", "medium", "high"])
    ).resolves.toBeUndefined();
    const switchCalls = requestedPaths.filter((entry) => entry.path === "/api/session/ses_abc123/model");
    expect(switchCalls.at(-1)?.body).toMatchObject({ model: { id: "kimi-k3", providerID: "legacy", variant: "default" } });
  });

  it("omits the variant when the reasoning effort is not advertised", async () => {
    await expect(
      switchOpenCodeSessionModel(controlFixture, "ses_abc123", "legacy", "kimi-k3", "max", ["low", "medium", "high"])
    ).resolves.toBeUndefined();
    const switchCalls = requestedPaths.filter((entry) => entry.path === "/api/session/ses_abc123/model");
    const lastBody = switchCalls.at(-1)?.body as { model?: Record<string, string> } | undefined;
    expect(lastBody?.model).toEqual({ id: "kimi-k3", providerID: "legacy" });
    expect(lastBody?.model).not.toHaveProperty("variant");
  });

  it("omits the variant when no advertised variants are supplied", async () => {
    await expect(
      switchOpenCodeSessionModel(controlFixture, "ses_abc123", "opencode", "deepseek-v4-flash-free", "high")
    ).resolves.toBeUndefined();
    const switchCalls = requestedPaths.filter((entry) => entry.path === "/api/session/ses_abc123/model");
    expect(switchCalls.at(-1)?.body).toMatchObject({ model: { id: "deepseek-v4-flash-free", providerID: "opencode" } });
    expect(switchCalls.at(-1)?.body?.model).not.toHaveProperty("variant");
  });

  it("omits the variant when no reasoning effort is supplied", async () => {
    await expect(
      switchOpenCodeSessionModel(controlFixture, "ses_abc123", "opencode", "deepseek-v4-flash-free", null)
    ).resolves.toBeUndefined();
    const switchCalls = requestedPaths.filter((entry) => entry.path === "/api/session/ses_abc123/model");
    expect(switchCalls.at(-1)?.body).toMatchObject({ model: { id: "deepseek-v4-flash-free", providerID: "opencode" } });
    expect(switchCalls.at(-1)?.body?.model).not.toHaveProperty("variant");
  });

  it("rejects a model switch when the server errors", async () => {
    await expect(
      switchOpenCodeSessionModel(controlFixture, "ses_unknown", "opencode", "kimi-k3")
    ).rejects.toThrow(/HTTP 404/);
  });

  it("points the control path into the state root", () => {
    expect(opencodeServerControlPath("cli_session:a/b", "/root/state")).toBe(
      "/root/state/opencode/space-cli-control/cli_session_a_b.json"
    );
  });
});
