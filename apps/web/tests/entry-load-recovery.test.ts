/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ENTRY_LOAD_RECOVERY_STORAGE_KEY,
  handleStaleBuildLoadError
} from "../src/entry-load-recovery.js";

function createStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    store
  };
}

describe("Space entry load recovery", () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="root"></main>';
  });

  it("reloads once for stale dynamic import failures", () => {
    const storage = createStorage();
    const reload = vi.fn();
    const root = document.getElementById("root");

    const handled = handleStaleBuildLoadError(
      new TypeError("Failed to fetch dynamically imported module: /assets/LiveSpaceApp-old.js"),
      { storage, rootElement: root, reload }
    );

    expect(handled).toBe(true);
    expect(storage.store.get(ENTRY_LOAD_RECOVERY_STORAGE_KEY)).toBe("1");
    expect(reload).toHaveBeenCalledOnce();
    expect(root?.textContent).toBe("");
  });

  it("renders a manual reload fallback instead of looping after the retry was used", () => {
    const storage = createStorage({ [ENTRY_LOAD_RECOVERY_STORAGE_KEY]: "1" });
    const reload = vi.fn();
    const root = document.getElementById("root");

    const handled = handleStaleBuildLoadError(
      Object.assign(new Error("Loading chunk LiveSpaceApp failed"), { name: "ChunkLoadError" }),
      { storage, rootElement: root, reload }
    );

    expect(handled).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    const button = root?.querySelector("button");
    expect(button?.textContent).toBe("Reload Space");

    button?.click();

    expect(reload).toHaveBeenCalledOnce();
  });
});
