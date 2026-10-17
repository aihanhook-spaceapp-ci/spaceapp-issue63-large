import { describe, expect, it, vi } from "vitest";
import { readRoomHostScreen } from "../src/room-host-screen.js";
import { projectRoomTerminalScreen, roomTerminalMode, restoreRoomTerminalGeometry } from "../src/room-terminal-screen.js";
import { CliTerminalManager } from "../src/cli-terminal.js";
import { getApiConfig } from "../src/config.js";
import { InMemorySpaceStore } from "@space/runtime";

const identity = { cliSessionId: "cli_session:proof", paneId: "pane:proof", roomId: "room:proof", runtimeId: "cli:opencode", codexThreadId: null, modelId: null, reasoningEffort: null };
describe("Room Agent host screen observer", () => {
  it("reads a resumed OpenCode host after its observer disconnects, without an API-managed transport", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Unmanaged OpenCode", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "OpenCode", mode: "TERMINAL", terminalRuntimeId: "cli:opencode" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:opencode", providerId: "opencode", agentId: "opencode", status: "RUNNING" });
    store.updatePaneCliTerminalGeometry(session.sessionId, { generationId: "current-host", cols: 61, rows: 74 });
    // No DB transcript and no manager attach. The independent host still owns
    // the complete composer and its real revision.
    let generationId = "current-host";
    const host = {
      attach: vi.fn(async () => ({ attachmentId: "observer", session: { generationId, nextOutputSequence: 123 }, replay: [{
        data: "\x1b[70;3H┃\x1b[71;3H┃  Build · Model\x1b[72;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[73;4H/etc  15.6K (1%)  ctrl+p commands"
      }] })),
      detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn()
    };
    const manager = new CliTerminalManager({ store, config: getApiConfig({}), hostClient: host as never,
      discoverRuntimes: vi.fn() });
    const observation = await manager.observeRoomScreen(session.sessionId);
    expect(observation.revision).toBe(123);
    expect(roomTerminalMode("cli:opencode", observation.text, ["build"])).toBe("build");
    expect(host.attach.mock.calls[0]).toEqual([{ identity: expect.objectContaining({ cliSessionId: session.sessionId, roomId: room.id, paneId: pane.id }), afterSequence: -1 }]);
    generationId = "different-host";
    expect(await manager.observeRoomScreen(session.sessionId)).toEqual({ text: "", revision: 0 });
    expect(host.detach).toHaveBeenCalledTimes(2);
    expect(host.input).not.toHaveBeenCalled();
    expect(host.resize).not.toHaveBeenCalled();
    expect(host.terminate).not.toHaveBeenCalled();
  });
  it("restores confirmed tall-pane dimensions after API restart and rejects another host generation", async () => {
    const persisted = { generationId: "host-generation", cols: 61, rows: 74 };
    const geometry = restoreRoomTerminalGeometry("host-generation", true, persisted, { cols: 100, rows: 30 })!;
    const composer = "\x1b[2J\x1b[70;3H┃\x1b[71;3H┃  Build   Muse Spark 1.2 Free OpenCode Zen\x1b[72;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[73;4H/etc     15.6K (1%)  ctrl+p commands";
    expect(roomTerminalMode("cli:opencode", await projectRoomTerminalScreen([composer]), ["build", "plan"])).toBeNull();
    const screen = await projectRoomTerminalScreen([composer], geometry.cols, geometry.rows);
    expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("build");
    expect(restoreRoomTerminalGeometry("replacement", true, persisted)).toBeNull();
    expect(restoreRoomTerminalGeometry("host-generation", true, null, { cols: 61, rows: 74 })).toBeNull();
    expect(restoreRoomTerminalGeometry("replacement", false, persisted)).toEqual({ cols: 100, rows: 30 });
    expect(roomTerminalMode("cli:opencode", "Build   historical output\ntab agents", ["build"])).toBeNull();
  });
  it("retains the unchanged composer after more than 200 animation chunks, without modifying the live pane", async () => {
    const composer = "\x1b[2J\x1b[26;3H┃\x1b[27;3H┃  Build · Muse Spark 1.2 Free OpenCode Zen\x1b[28;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[29;4H/etc\x1b[29;72H15.9K (2%)  ctrl+p commands";
    const chunks = [composer, ...Array.from({ length: 300 }, (_, i) => `\x1b[10;6HThought · ${i}ms`)];
    const host = {
      attach: vi.fn(async () => ({ attachmentId: "observer", session: {} as never,
        replay: chunks.map((data, sequence) => ({ type: "output" as const, stream: "stdout" as const, generationId: "generation", sequence, data })) })),
      detach: vi.fn(async () => true), input: vi.fn(), resize: vi.fn(), terminate: vi.fn()
    };
    expect(roomTerminalMode("cli:opencode", await projectRoomTerminalScreen(chunks.slice(-200)), ["build", "plan"])).toBeNull();
    const screen = await readRoomHostScreen(host, identity, 100, 30);
    expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("build");
    expect(host.attach).toHaveBeenCalledExactlyOnceWith({ identity, afterSequence: -1 });
    expect(host.detach).toHaveBeenCalledExactlyOnceWith(identity, "observer");
    expect(host.input).not.toHaveBeenCalled();
    expect(host.resize).not.toHaveBeenCalled();
    expect(host.terminate).not.toHaveBeenCalled();
  });
  it("propagates missing host replay without spawning or detaching another attachment", async () => {
    const host = { attach: vi.fn(async () => { throw Error("CLI_HOST_REPLAY_GAP"); }), detach: vi.fn() };
    await expect(readRoomHostScreen(host, identity, 100, 30)).rejects.toThrow("CLI_HOST_REPLAY_GAP");
    expect(host.detach).not.toHaveBeenCalled();
    expect(host.attach.mock.calls[0]).toEqual([{ identity, afterSequence: -1 }]);
  });
  it("preserves the composer and ANSI state across more than 1 MiB of animation deltas", async () => {
    const composer = "\x1b[?1049h\x1b[2J\x1b[26;3H┃\x1b[27;3H┃  Plan · Muse Spark 1.2 Free OpenCode Zen\x1b[28;3H╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\x1b[29;4H/etc\x1b[29;72H15.9K (2%)  ctrl+p commands";
    const deltas = "\x1b[10;6HThought · 1234ms".repeat(50_000);
    expect(Buffer.byteLength(deltas)).toBeGreaterThan(1_048_576);
    const screen = await projectRoomTerminalScreen([composer, deltas]);
    expect(roomTerminalMode("cli:opencode", screen, ["build", "plan"])).toBe("plan");
  });
  it("rejects oversized replay instead of guessing from a truncated ANSI stream", async () => {
    await expect(projectRoomTerminalScreen(["x".repeat(8 * 1024 * 1024 + 1)])).rejects.toThrow("projection limit");
  });
});

describe("Room screen projection without faint text", () => {
  it("blanks faint cells such as a composer suggestion and keeps normal text", async () => {
    // Claude Code draws its prompt suggestion faint (SGR 2) in an otherwise empty composer.
    const chunks = ["Normal \x1b[2mfaint\x1b[22m kept\r\n❯ \x1b[2mrun the tests\x1b[22m\r\n❯ typed draft"];
    expect(await projectRoomTerminalScreen(chunks, 40, 5)).toContain("❯ run the tests");
    const undimmed = (await projectRoomTerminalScreen(chunks, 40, 5, true, true)).split("\n");
    expect(undimmed.slice(0, 3)).toEqual(["Normal       kept", "❯", "❯ typed draft"]);
  });
});
