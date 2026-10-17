import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SpaceNotFoundError } from "../src/index.js";

describe("clipboard store", () => {
  it("deduplicates exact text per user, moves it to the top, and updates occurrence metadata", () => {
    const store = new InMemorySpaceStore();
    const first = store.upsertClipboardItem({ ownerUserId: "user:one", text: "same text", source: "COPY" });
    const other = store.upsertClipboardItem({ ownerUserId: "user:one", text: "other text", source: "COPY" });
    const repeated = store.upsertClipboardItem({
      ownerUserId: "user:one",
      text: "same text",
      source: "PASTE",
      roomId: "room:one",
      paneId: "pane:one",
      paneTitle: "Drafts"
    });

    expect(repeated).toMatchObject({
      id: first.id,
      text: "same text",
      source: "PASTE",
      roomId: "room:one",
      paneId: "pane:one",
      occurrenceCount: 2
    });
    expect(repeated.createdAt).toBe(first.createdAt);
    expect(store.listClipboardItems("user:one", { page: 1, pageSize: 25 })).toMatchObject({
      total: 2,
      items: [{ id: first.id }, { id: other.id }]
    });
  });

  it("treats whitespace and case differences as distinct exact clips", () => {
    const store = new InMemorySpaceStore();
    store.upsertClipboardItem({ ownerUserId: "user:one", text: "Alpha", source: "COPY" });
    store.upsertClipboardItem({ ownerUserId: "user:one", text: "alpha", source: "COPY" });
    store.upsertClipboardItem({ ownerUserId: "user:one", text: " Alpha ", source: "COPY" });

    expect(store.listClipboardItems("user:one", { page: 1, pageSize: 25 }).total).toBe(3);
  });

  it("isolates list, get, delete, and clear operations by owner", () => {
    const store = new InMemorySpaceStore();
    const one = store.upsertClipboardItem({ ownerUserId: "user:one", text: "private one", source: "MANUAL_NOTE" });
    const two = store.upsertClipboardItem({ ownerUserId: "user:two", text: "private two", source: "MANUAL_NOTE" });

    expect(store.listClipboardItems("user:one", { page: 1, pageSize: 25 }).items).toEqual([one]);
    expect(store.getClipboardItem("user:one", two.id)).toBeNull();
    expect(() => store.deleteClipboardItem("user:one", two.id)).toThrow(SpaceNotFoundError);
    expect(store.clearClipboardItems("user:one")).toBe(1);
    expect(store.getClipboardItem("user:two", two.id)).toEqual(two);
    expect(store.snapshot().clipboardItems).toEqual([
      { ownerUserId: "user:two", item: two }
    ]);
  });

  it("prunes each user's history to the 100 most recently used unique clips", () => {
    const store = new InMemorySpaceStore();
    for (let index = 0; index < 101; index += 1) {
      store.upsertClipboardItem({ ownerUserId: "user:one", text: `clip ${index}`, source: "COPY" });
    }

    const page = store.listClipboardItems("user:one", { page: 1, pageSize: 100 });
    expect(page.total).toBe(100);
    expect(page.items[0]?.text).toBe("clip 100");
    expect(page.items.some((item) => item.text === "clip 0")).toBe(false);
  });

  it("searches case-insensitively, filters sources, and paginates newest first", () => {
    const store = new InMemorySpaceStore();
    store.upsertClipboardItem({ ownerUserId: "user:one", text: "Fallback policy", source: "COPY" });
    store.upsertClipboardItem({ ownerUserId: "user:one", text: "Unrelated", source: "PASTE" });
    store.upsertClipboardItem({ ownerUserId: "user:one", text: "Verify FALLBACK now", source: "AGENT_NOTE" });

    expect(
      store.listClipboardItems("user:one", { q: "fallback", source: "AGENT_NOTE", page: 1, pageSize: 25 })
    ).toMatchObject({ total: 1, items: [{ text: "Verify FALLBACK now", source: "AGENT_NOTE" }] });
    expect(store.listClipboardItems("user:one", { page: 2, pageSize: 2 })).toMatchObject({
      total: 3,
      items: [{ text: "Fallback policy" }]
    });
  });

  it("stores full-size plans with a title and lists them by the PLAN source", () => {
    const store = new InMemorySpaceStore();
    const planText = "x".repeat(100_000);
    const plan = store.upsertClipboardItem({
      ownerUserId: "user:one",
      text: planText,
      source: "PLAN",
      title: "Rollout plan",
      minimumModel: "gpt-5.6-sol"
    });

    expect(plan).toMatchObject({ source: "PLAN", title: "Rollout plan", characterCount: 100_000, minimumModel: "gpt-5.6-sol" });
    const listed = store.listClipboardItems("user:one", { source: "PLAN", page: 1, pageSize: 25 }).items;
    expect(listed).toEqual([plan]);
    expect(store.listClipboardItems("user:one", { source: "AGENT_NOTE", page: 1, pageSize: 25 }).items).toEqual([]);
  });

  it("lists only the plans bound to a pane when paneId is given", () => {
    const store = new InMemorySpaceStore();
    const bound = store.upsertClipboardItem({ ownerUserId: "user:one", text: "bound plan", source: "PLAN", title: "Bound", minimumModel: "gpt-5.6-sol", paneId: "pane:bob1234" });
    store.upsertClipboardItem({ ownerUserId: "user:one", text: "other plan", source: "PLAN", title: "Other", minimumModel: "gpt-5.6-sol", paneId: "pane:dana1234" });
    const completed = store.setClipboardItemCompleted("user:one", bound.id, true);
    expect(store.listClipboardItems("user:one", { source: "PLAN", includeCompleted: true, paneId: "pane:bob1234", page: 1, pageSize: 1 }).items).toEqual([completed]);
    expect(store.listClipboardItems("user:one", { source: "PLAN", includeCompleted: false, paneId: "pane:bob1234", page: 1, pageSize: 1 }).items).toEqual([]);
    expect(store.listClipboardItems("user:two", { source: "PLAN", includeCompleted: true, paneId: "pane:bob1234", page: 1, pageSize: 1 }).items).toEqual([]);
  });

  it("marks plans completed, hides them by request, and keeps the flag on re-save", () => {
    const store = new InMemorySpaceStore();
    const plan = store.upsertClipboardItem({
      ownerUserId: "user:one",
      text: "plan text",
      source: "PLAN",
      title: "Plan",
      minimumModel: "gpt-5.6-sol"
    });
    expect(plan.isCompleted).toBe(false);

    const completed = store.setClipboardItemCompleted("user:one", plan.id, true);
    expect(completed.isCompleted).toBe(true);
    expect(store.listClipboardItems("user:one", { page: 1, pageSize: 25 }).items[0]?.isCompleted).toBe(true);
    expect(store.listClipboardItems("user:one", { includeCompleted: false, page: 1, pageSize: 25 }).items).toEqual([]);
    expect(store.listClipboardItems("user:one", { includeCompleted: true, page: 1, pageSize: 25 }).items).toEqual([
      completed
    ]);

    const reSaved = store.upsertClipboardItem({
      ownerUserId: "user:one",
      text: "plan text",
      source: "PLAN",
      title: "Rollout plan",
      minimumModel: "gpt-5.6-sol"
    });
    expect(reSaved.isCompleted).toBe(true);

    expect(() => store.setClipboardItemCompleted("user:two", plan.id, true)).toThrow(SpaceNotFoundError);
  });

  it("rejects PLAN upsert when minimumModel is omitted or invalid", () => {
    const store = new InMemorySpaceStore();
    expect(() =>
      store.upsertClipboardItem({
        ownerUserId: "user:one",
        text: "plan text",
        source: "PLAN",
        title: "Plan"
      })
    ).toThrow();

    expect(() =>
      store.upsertClipboardItem({
        ownerUserId: "user:one",
        text: "normal note",
        source: "COPY",
        minimumModel: "gpt-5.6-sol"
      })
    ).toThrow();
  });
});


it("persists plan reasoning and preserves it when the same plan is copied without recommendations", () => {
  const store = new InMemorySpaceStore();
  const plan = store.upsertClipboardItem({ ownerUserId: "user:one", text: "reasoning plan", source: "PLAN", minimumModel: "gpt-6.1-sol", minimumReasoning: "high" });
  expect(plan.minimumReasoning).toBe("high");
  const repeated = store.upsertClipboardItem({ ownerUserId: "user:one", text: "reasoning plan", source: "PLAN", minimumModel: "gpt-6.1-sol" });
  expect(repeated.id).toBe(plan.id);
  expect(store.getClipboardItem("user:one", plan.id)?.minimumReasoning).toBe("high");
  expect(store.getClipboardItem("user:two", plan.id)).toBeNull();
});
