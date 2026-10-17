import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("dock header desktop titlebar integration", () => {
  const titlebarCss = readFileSync(resolve(__dirname, "../src/features/desktop-titlebar/desktop-window-titlebar.css"), "utf8");
  const stylesCss = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");
  const workspaceChromeCss = readFileSync(resolve(__dirname, "../src/features/ui-theme/workspace-chrome.css"), "utf8");
  const desktopNavCss = readFileSync(resolve(__dirname, "../src/features/ui-theme/desktop-navigation.css"), "utf8");

  it("declares root desktop-titlebar-height fallback and titlebar heights", () => {
    expect(titlebarCss).toMatch(/--desktop-titlebar-height:\s*0px/);
    expect(titlebarCss).toMatch(/body:has\(\.desktop-window-titlebar\)/);
    expect(titlebarCss).toMatch(/\.space-shell:has\(\.desktop-window-titlebar\)/);
    expect(titlebarCss).toMatch(/--desktop-titlebar-height:\s*32px/);
  });

  it("resets desktop-titlebar-height to 0px in fullscreen mode", () => {
    expect(titlebarCss).toMatch(/\[data-browser-fullscreen="true"\]/);
    expect(titlebarCss).toMatch(/--desktop-titlebar-height:\s*0px\s*!important/);
  });

  it("offsets side-surface-drawer below desktop titlebar and safe area", () => {
    expect(stylesCss).toMatch(/\.side-surface-drawer\s*\{[^}]*inset:\s*max\(var\(--desktop-titlebar-height,\s*0px\)/);
    expect(workspaceChromeCss).toMatch(/\.side-surface-drawer[^}]*inset:\s*max\(var\(--desktop-titlebar-height,\s*0px\)/);
  });

  it("offsets surface-dismiss-layer below desktop titlebar and safe area", () => {
    expect(stylesCss).toMatch(/\.surface-dismiss-layer\s*\{[^}]*inset:\s*max\(var\(--desktop-titlebar-height,\s*0px\)/);
  });

  it("ensures side-surface-inline has overflow: hidden so dock header cannot scroll offscreen", () => {
    expect(desktopNavCss).toMatch(/\.space-shell\.shell-desktop\s+\.side-surface-inline\s*\{[^}]*overflow:\s*hidden;/);
  });
});
