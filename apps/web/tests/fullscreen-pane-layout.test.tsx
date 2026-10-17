import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Fullscreen Pane Layout Sizing and Styles", () => {
  it("defines full screen rules in styles.css for pane-grid and pane-card", () => {
    const classicCss = readFileSync(resolve(__dirname, "../src/styles.css"), "utf8");

    expect(classicCss).toContain('.pane-grid[data-fullscreen-layout="true"]');
    expect(classicCss).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(classicCss).toContain("grid-template-rows: minmax(0, 1fr);");
    expect(classicCss).toContain('.pane-grid[data-fullscreen-layout="true"] .pane-card:not(.is-shell-hidden)');
    expect(classicCss).toContain("grid-column: 1 / -1;");
    expect(classicCss).toContain("grid-row: 1 / -1;");
  });
});
