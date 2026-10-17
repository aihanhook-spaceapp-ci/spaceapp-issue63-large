import { describe, expect, it } from "vitest";
import { projectRoomTerminalScreen, roomTerminalMode } from "../src/room-terminal-screen.js";

// Footers as Claude Code 2.1.296 draws them; background shells replace the "(shift+tab to cycle)" hint.
const prompt = ["────", "❯ ", "────"];
const panel = [
  "",
  "  ● main",
  "  ◯ Plan      Inspecting space-queue…  7m 13s · ↓ 231.2k tokens",
  "  ◯ Explore   Counting MCP servers…    4m 59s · ↓ 125.1k tokens",
  "  ◯ general-purpose  1h 58m 48s · ↓ 893.4k tokens · 1 queued"
];
const screen = (...lines: string[]) => [...prompt, ...lines].join("\n");

describe("Room Agent mode readback for Claude Code", () => {
  it("reads the mode while background shells and agents run", () => {
    expect(roomTerminalMode("cli:claude", screen("  ⏵⏵ bypass permissions on · 3 shells · ← for agents · ↓ …"))).toBe("bypass permissions");
    expect(roomTerminalMode("cli:claude", screen("  ⏸ plan mode on (shift+tab to cycle) · ← for agents · ↓ …", ...panel))).toBe("plan");
    expect(roomTerminalMode("cli:claude", screen("  ⏵⏵ accept edits on · 1 shell · esc to interrupt", ...panel))).toBe("accept edits");
    expect(roomTerminalMode("cli:claude", screen("  ⏵⏵ auto mode on (shift+tab to cycle) · ← for a…"))).toBe("auto");
    expect(roomTerminalMode("cli:claude", screen("  ? for shortcuts · ← for agents", ...panel))).toBe("default");
  });

  it("reads the projected screen and ignores a footer quoted in the conversation", async () => {
    const projected = await projectRoomTerminalScreen([
      [...prompt, "  \u001b[38;2;255;107;128m⏵⏵ bypass permissions on\u001b[39m\u001b[38;2;153;153;153m · 3 shells · ← for agents\u001b[39m", ...panel].join("\r\n")
    ], 100, 20);
    expect(roomTerminalMode("cli:claude", projected)).toBe("bypass permissions");
    expect(roomTerminalMode("cli:claude", ["⏵⏵ accept edits on · 3 shells", "⏺ That was the earlier footer.", ...prompt].join("\n"))).toBeNull();
    expect(roomTerminalMode("cli:claude", ["⏺ Branches:", "  ● main", "  ◯ feature", ...prompt, "  ⏸ plan mode on · 1 shell"].join("\n"))).toBe("plan");
  });
});
