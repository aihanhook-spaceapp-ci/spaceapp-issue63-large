import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const template = await readFile(new URL("../templates/compose.yml", import.meta.url), "utf8");
const images = [...template.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((match) => match[1]);
const storageSource = await readFile(new URL("../src/storage.mjs", import.meta.url), "utf8");

test("every compose image is pinned to a version or a digest", () => {
  assert.ok(images.length >= 7);
  for (const image of images) {
    if (image.startsWith("ghcr.io/oll4com/spaceapp-")) {
      assert.match(image, /:\$\{SPACEAPP_IMAGE_TAG\}$/, image);
      continue;
    }
    const tag = image.split("@")[0].split(":").at(-1);
    const digest = image.includes("@sha256:");
    assert.ok(digest || /\d/.test(tag), `${image} uses a moving tag`);
    assert.notEqual(tag, "latest", image);
  }
});

test("the headroom companion is pinned to the reviewed digest", () => {
  const headroom = images.find((image) => image.startsWith("ghcr.io/oll4com/headroom-codex-lb"));
  assert.match(headroom, /@sha256:[0-9a-f]{64}$/);
  assert.ok(storageSource.includes(`"${headroom}"`), "storage plan must estimate the same companion image");
});
