import { describe, expect, it, vi } from "vitest";
import { runDatabaseRetentionSweep } from "../src/app.js";

describe("Database Retention Sweep", () => {
  it("iterates in bounded batches until fewer than batchLimit are pruned", async () => {
    let callCount = 0;
    const mockStore: any = {
      pruneExpiredCliTranscriptChunks: vi.fn(async ({ olderThanDays, batchSize }) => {
        callCount++;
        if (callCount === 1) return { deletedChunks: 500 };
        if (callCount === 2) return { deletedChunks: 500 };
        return { deletedChunks: 120 };
      })
    };

    const result = await runDatabaseRetentionSweep({
      store: mockStore,
      olderThanDays: 7,
      batchLimit: 500,
      maxBatches: 10
    });

    expect(result.deletedChunks).toBe(1120);
    expect(result.batches).toBe(3);
    expect(mockStore.pruneExpiredCliTranscriptChunks).toHaveBeenCalledTimes(3);
    expect(mockStore.pruneExpiredCliTranscriptChunks).toHaveBeenCalledWith({
      olderThanDays: 7,
      batchSize: 500
    });
  });

  it("respects maxBatches bound to prevent runaway sweeps", async () => {
    const mockStore: any = {
      pruneExpiredCliTranscriptChunks: vi.fn(async () => ({ deletedChunks: 500 }))
    };

    const result = await runDatabaseRetentionSweep({
      store: mockStore,
      olderThanDays: 7,
      batchLimit: 500,
      maxBatches: 4
    });

    expect(result.deletedChunks).toBe(2000);
    expect(result.batches).toBe(4);
    expect(mockStore.pruneExpiredCliTranscriptChunks).toHaveBeenCalledTimes(4);
  });

  it("prunes closed panes older than 24 hours in bounded batches", async () => {
    let callCount = 0;
    const mockStore: any = {
      pruneClosedPanes: vi.fn(async ({ olderThanHours, batchSize }) => {
        callCount++;
        if (callCount === 1) return { deletedPanes: 500 };
        return { deletedPanes: 42 };
      })
    };

    const result = await runDatabaseRetentionSweep({
      store: mockStore,
      olderThanHoursForPanes: 24,
      batchLimit: 500,
      maxBatches: 5
    });

    expect(result.deletedPanes).toBe(542);
    expect(result.batches).toBe(2);
    expect(mockStore.pruneClosedPanes).toHaveBeenCalledTimes(2);
    expect(mockStore.pruneClosedPanes).toHaveBeenCalledWith({
      olderThanHours: 24,
      batchSize: 500
    });
  });

  it("executes combined retention sweep for both transcript chunks and closed panes", async () => {
    const mockStore: any = {
      pruneExpiredCliTranscriptChunks: vi.fn(async () => ({ deletedChunks: 15 })),
      pruneClosedPanes: vi.fn(async () => ({ deletedPanes: 25 }))
    };

    const result = await runDatabaseRetentionSweep({
      store: mockStore,
      olderThanDays: 7,
      olderThanHoursForPanes: 24,
      batchLimit: 500,
      maxBatches: 5
    });

    expect(result.deletedChunks).toBe(15);
    expect(result.deletedPanes).toBe(25);
    expect(result.batches).toBe(1);
  });
});
