import { describe, expect, it } from "vitest";
import type { ClaudeUsageAccount } from "@space/contracts";
import { claudeAccountEntries, claudeApiKeyHint, claudeStatusLabel } from "../src/features/toolbar-metrics/account-entries.js";
import { cliAccountAvailability } from "../src/features/cli-accounts/cli-account-availability.js";

const clock = Date.parse("2026-10-13T08:00:00.000Z");
const apiCard = (patch: Partial<ClaudeUsageAccount> = {}): ClaudeUsageAccount => ({
  id: "api", label: "api", email: null, plan: null, status: "API_KEY", fiveHourRemainingPercent: null, fiveHourResetAt: null,
  weeklyRemainingPercent: null, weeklyResetAt: null, weeklyScope: null, sampledAt: null, ...patch
});

describe("Claude API key card", () => {
  it("shows a checked key as connected and says what Space Gateway does with it", () => {
    expect(claudeStatusLabel(apiCard())).toBe("API key");
    expect(claudeStatusLabel(apiCard({ apiKeyVerified: true }))).toBe("Connected · API key");
    expect(claudeStatusLabel(apiCard({ apiKeyVerified: false }))).toBe("API key rejected");
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "ON" })))
      .toBe("Paid per token; panes never choose it automatically. Space Gateway uses it while every pooled Claude account is out of quota, and returns to the accounts at their reset.");
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "OFF" }))).toMatch(/fallback is off/);
    expect(claudeApiKeyHint(apiCard({ gatewayFallback: "NOT_ADDED" }))).toMatch(/Add it to Space Gateway/);
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: false }))).toBe("Anthropic rejected this API key.");
    // What went through the key: nothing, or how much and when.
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "ON", apiKeyUsage: { requests: 0, costUsd: 0, lastUsedAt: null } }), clock))
      .toMatch(/at their reset\. Never used by Space Gateway\.$/);
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "ON", apiKeyUsage: { requests: 3, costUsd: 0.4321, lastUsedAt: new Date(clock - 7 * 60_000).toISOString() } }), clock))
      .toMatch(/at their reset\. Used 3 times through Space Gateway \(\$0\.43\), last 7m ago\.$/);
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "OFF", apiKeyUsage: { requests: 1, costUsd: 0.001, lastUsedAt: new Date(clock - 3 * 3_600_000).toISOString() } }), clock))
      .toMatch(/fallback is off .*Used 1 time through Space Gateway, last 3h ago\.$/);
    const [used] = claudeAccountEntries([apiCard({ apiKeyVerified: true, gatewayFallback: "ON", apiKeyUsage: { requests: 2, costUsd: 0.5, lastUsedAt: new Date(clock - 60_000).toISOString() } })], clock);
    expect(used!.hint).toMatch(/Used 2 times through Space Gateway \(\$0\.50\), last 1m ago\.$/);
    const [entry] = claudeAccountEntries([apiCard({ apiKeyVerified: true, gatewayFallback: "ON" })], clock);
    // Never counted as an available quota account: panes do not pick it on their own.
    expect(entry).toMatchObject({ availability: { state: "offline" }, offlineLabel: "Connected · API key", rows: [] });
  });

  it("labels the key in the pane account picker without making it a pick", () => {
    const pick = (patch: Partial<ClaudeUsageAccount>) => cliAccountAvailability({
      runtimeId: "cli:claude", profileId: "api", identity: null, clock,
      quota: { codex: null, agy: null, api: null, fetchedAt: clock, claude: { data: [apiCard(patch)], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        source: "space-claude-profiles", isStale: false, error: null, checkedAt: new Date(clock).toISOString() } }
    });
    expect(pick({ apiKeyVerified: true, gatewayFallback: "ON" })).toMatchObject({ tone: "off", label: "Paid · ready",
      description: "Paid per token · never chosen automatically · Space Gateway fallback on" });
    expect(pick({ apiKeyVerified: false })).toMatchObject({ tone: "off", label: "Key rejected" });
    expect(pick({})).toMatchObject({ tone: "off", label: "Paid · not used", description: "Paid per token · never chosen automatically" });
  });
});
