import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Stacked copilot panes (phones) draw the main surface and the rail body in one grid cell; while the main surface
// is shown, the rail body must be hidden or it covers the browser (Job Copilot) or the mailbox (Mail Copilot).
const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src/features");
const css = readFileSync(resolve(src, "copilot-kit/copilot-pane.css"), "utf8");
const hideRule = css.split("\n").find((line) => line.includes(".jc-rail-body { visibility: hidden; pointer-events: none; }"))!;

describe("stacked copilot surfaces", () => {
  it.each([
    ["job-apply-pane/JobCopilotPane.tsx", "data-browser"],
    ["mail-copilot-pane/MailCopilotPane.tsx", "data-mail"]
  ])("%s marks its shown surface with %s and the rail body gives way to it", (file, attribute) => {
    expect(readFileSync(resolve(src, file), "utf8")).toContain(`${attribute}={`);
    expect(hideRule).toContain(`[${attribute}="visible"]`);
    expect(css).toMatch(new RegExp(`\\[${attribute}="hidden"\\][^{]*\\.jc-rail-body \\{ z-index: 1; \\}`));
  });
});
