import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@space/contracts";
import { cliRuntimeDescriptors } from "../src/cli-runtime-descriptors.js";
import {
  checkCliRuntimeCredential,
  credentialSmokeTimeoutForRuntime
} from "../src/cli-runtimes.js";

function runtime(id: string): AgentRuntime {
  const descriptor = cliRuntimeDescriptors.find((candidate) => candidate.id === id)!;
  return {
    id,
    providerId: descriptor.providerId,
    providerName: descriptor.providerName,
    agentId: descriptor.key,
    agentName: descriptor.agentName,
    displayName: descriptor.agentName,
    capabilities: ["CLI"],
    adapterStatus: "ENABLED",
    authMode: descriptor.authMode,
    authState: "READY",
    authReason: "Credential material is present.",
    canStartLogin: false,
    status: "ENABLED",
    statusReason: "Credential material is present.",
    commandName: descriptor.commandName,
    detectedCommandPath: `/controlled/${descriptor.commandName}`,
    defaultModelId: descriptor.defaultModelId,
    supportedReasoningEfforts: [],
    checkedAt: "2026-07-29T09:00:00.000Z"
  };
}

describe("setup credential check runtime", () => {
  it("allows 180-second Codex wrappers to finish instead of timing out at 155 seconds", async () => {
    expect(credentialSmokeTimeoutForRuntime("cli:codex")).toBe(190_000);
    expect(credentialSmokeTimeoutForRuntime("cli:kimi")).toBe(190_000);
    expect(credentialSmokeTimeoutForRuntime("cli:gemini")).toBe(130_000);

    const execute = vi.fn(async (
      _commandPath: string,
      _args: readonly string[],
      options: { timeout: number }
    ) => {
      expect(options.timeout).toBe(190_000);
      return { stdout: "SPACE_CODEX_OK\n" };
    });
    await expect(checkCliRuntimeCredential(runtime("cli:codex"), execute)).resolves.toEqual({
      outcome: "VERIFIED"
    });
  });

  it("uses the same home and CLI credential paths as the terminal runtime", async () => {
    let childEnvironment: NodeJS.ProcessEnv | undefined;
    await expect(checkCliRuntimeCredential(
      runtime("cli:qwen"),
      async (_commandPath, _args, options) => {
        childEnvironment = options.env;
        return { stdout: "SPACE_QWEN_OK\n" };
      }
    )).resolves.toEqual({ outcome: "VERIFIED" });

    expect(childEnvironment?.HOME).toBe(process.env.HOME ?? "/var/lib/spaceapp-user");
    expect(childEnvironment?.QWEN_HOME).toBe("/var/lib/spaceapp-user/.codex/space-qwen");
    expect(childEnvironment?.QWEN_RUNTIME_DIR).toBe("/var/lib/spaceapp-user/.codex/space-qwen/runtime");
  });

  it("recognizes only the bounded quota marker as quota limited", async () => {
    await expect(checkCliRuntimeCredential(
      runtime("cli:kimi"),
      async () => ({ stdout: "SPACE_KIMI_QUOTA_LIMITED\n" })
    )).resolves.toEqual({ outcome: "QUOTA_LIMITED" });

    await expect(checkCliRuntimeCredential(
      runtime("cli:kimi"),
      async () => ({ stdout: "quota-ish provider prose\n" })
    )).resolves.toEqual({ outcome: "PROVIDER_FAILED" });
  });

  it("keeps process timeouts distinct from provider failures", async () => {
    await expect(checkCliRuntimeCredential(
      runtime("cli:codex"),
      async () => {
        throw Object.assign(new Error("command timed out"), {
          code: "ETIMEDOUT",
          killed: true,
          signal: "SIGTERM"
        });
      }
    )).resolves.toEqual({ outcome: "TIMED_OUT" });

    await expect(checkCliRuntimeCredential(
      runtime("cli:codex"),
      async () => {
        throw Object.assign(new Error("provider rejected request"), {
          code: 64,
          killed: false,
          signal: null
        });
      }
    )).resolves.toEqual({ outcome: "PROVIDER_FAILED" });
  });
});
