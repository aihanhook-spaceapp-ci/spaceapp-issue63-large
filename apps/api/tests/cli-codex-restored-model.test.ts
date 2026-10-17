import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { CliHostClient } from "@space/cli-host";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp, type CreateAppOptions } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import type { SpaceAgentControl } from "../src/space-agent.js";
import { ownedSystemAnalytics } from "./owned-system-analytics.js";
const csrfHeaderName = "x-space-csrf-token";
vi.setConfig({ testTimeout: 20_000 });
async function authedApp(options: CreateAppOptions = {}) {
  const cliHostClient = options.cliHostClient ?? {
    input: async () => { throw new Error("Model settings must never write terminal input"); },
    health: async () => ({ ok: true, sessions: [] }),
    inspect: async () => null,
    close: async () => undefined
  } as unknown as CliHostClient;
  const codexAgentControl = options.config?.cliEnabled && !Object.hasOwn(options, "codexAgentControl")
    ? testCodexAgentControl
    : options.codexAgentControl;
  const analyticsRoot = await mkdtemp(join(tmpdir(), "space-restored-model-analytics-"));
  const app = await createApp({
    // Background analytics must not scan the operator's CLI history.
    ...(options.store ? { systemAnalyticsService: ownedSystemAnalytics(options.store, analyticsRoot) } : {}),
    ...options,
    ...(Object.hasOwn(options, "codexAgentControl") || options.config?.cliEnabled
      ? { codexAgentControl: codexAgentControl ?? null }
      : {}),
    cliHostClient,
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false,
      ...(options.auth ?? {})
    }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const cookie = login.cookies[0]?.value;
  const cookieHeader = `space_session=${cookie}`;
  const csrf = await app.inject({
    method: "GET",
    url: "/api/auth/csrf",
    headers: { cookie: cookieHeader }
  });
  return { app, cookie: cookieHeader, csrfToken: csrf.json().csrfToken as string };
}

const testCodexAgentControl = {
  async readConfigRequirements() {
    return {
      allowedApprovalPolicies: ["on-request", "never"],
      allowedApprovalsReviewers: ["user", "guardian_subagent"],
      allowedSandboxModes: ["workspace-write", "danger-full-access"],
      defaultPermissions: null
    };
  },
  async listModels() {
    return [{
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      description: "Provider-advertised integration-test model.",
      isDefault: true,
      defaultReasoningEffort: "xhigh",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"]
    }];
  },
  async listCollaborationModes() {
    return [{
      name: "Default",
      mode: "default" as const,
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh"
    }];
  },
  async setGoal() {
    throw new Error("Goal control is not used by CLI runtime tests.");
  },
  async clearGoal() {
    throw new Error("Goal control is not used by CLI runtime tests.");
  }
} satisfies SpaceAgentControl;

async function enabledCliConfig(commandDir: string, extra: NodeJS.ProcessEnv = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "space-cli-workspaces-"));
  return getApiConfig({
    SPACE_CLI_ENABLED: "true",
    SPACE_CLI_COMMAND_PATH: commandDir,
    SPACE_CLI_CODEX_CREDENTIAL_SMOKE: "true",
    SPACE_CLI_WORKSPACE_ROOT: workspaceRoot,
    ...extra
  });
}


describe("Restored Codex model settings", () => {
  it.each([null, "11111111-1111-4111-8111-111111111111"])("controls the TUI restored task despite ambiguous locks and stale mapping %s", async (mappedThread) => {
    const commandDir = await mkdtemp(join(tmpdir(), "space-restored-model-"));
    await writeFile(join(commandDir, "codex-vscode-parity"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Restored settings", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Restored Codex", mode: "TERMINAL", cwd: "/new-pane" });
    const restoredThread = "22222222-2222-4222-8222-222222222222";
    const session = store.createPaneCliSession({ sessionId: "cli_session:restored-settings", paneId: pane.id, roomId: room.id,
      runtimeId: "cli:codex", providerId: "openai", agentId: "codex", modelId: "gpt-5.5", reasoningEffort: "medium",
      cwd: "/new-pane", codexThreadId: mappedThread, status: "RUNNING", isActive: true });
    let native = { modelId: "gpt-5.5", reasoningEffort: "medium", cwd: "/original-task", isTurnActive: false };
    const { app, cookie, csrfToken } = await authedApp({ store, config: await enabledCliConfig(commandDir),
      findCodexThreadId: async () => null,
      findCurrentCodexCliTurnActivity: async () => ({ status: "IDLE", turnId: null }),
      findCodexModelControlThreads: async () => ["11111111-1111-4111-8111-111111111111", restoredThread],
      codexSessionSocketProbe: async () => true,
      codexSocketControlFactory: () => ({
        listModels: async () => [{ id: "gpt-5.5", displayName: "GPT", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["medium", "high"] }],
        readCurrentThreadId: async () => restoredThread,
        readThreadSettings: async (id) => { expect(id).toBe(restoredThread); return native; },
        updateThreadSettings: async input => { await input.beforeSend?.(); expect(input.threadId).toBe(restoredThread); native = { ...native, reasoningEffort: input.reasoningEffort }; },
        interruptTurn: async () => { throw new Error("Must not interrupt the restored task"); },
        startTurn: async () => { throw new Error("Must not submit a prompt"); }
      })
    });
    try {
      const response = await app.inject({ method: "PATCH", url: `/api/panes/${encodeURIComponent(pane.id)}/cli/model-settings`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: { expectedSessionId: session.sessionId, modelId: "gpt-5.5", reasoningEffort: "high", continueActiveTurn: false } });
      expect(response.statusCode).toBe(200);
      expect(response.json().settings).toMatchObject({ threadId: restoredThread, current: { reasoningEffort: "high" } });
      expect(native.reasoningEffort).toBe("high");
    } finally {
      store.updatePaneCliSession(session.sessionId, { status: "EXITED", isActive: false });
      await app.close(); await rm(commandDir, { recursive: true, force: true });
    }
  });

});
