import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// SpaceApp is source-available (BSL) until its Change Date; the UI must not call it open source
// (review 2026-10-14: banner, widget and settings texts said "Free & Open Source").
const webRoot = join(import.meta.dirname, "..");
function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "downloads" ? [] : textFiles(path);
    return /\.(?:tsx?|svg|html|json|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("licence wording in the web app", () => {
  it("never calls SpaceApp open source", () => {
    const offenders = [...textFiles(join(webRoot, "src")), ...textFiles(join(webRoot, "public"))]
      .filter((file) => /open[\s_-]?source/i.test(readFileSync(file, "utf8")))
      .map((file) => relative(webRoot, file));
    expect(offenders).toEqual([]);
  });
});
