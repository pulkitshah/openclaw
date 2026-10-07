import { describe, expect, it, vi } from "vitest";
import { backfillFromUsage } from "./backfill.js";
import { DEFAULT_RATE_CARD } from "./money.js";
import { memoryStore } from "./store.test-helpers.js";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const lookups = {
  memberName: async (id: string) => (id === "asha" ? "Asha" : undefined),
  groupName: async () => undefined,
  mailAgentIds: () => ["duties-mail"],
};
// 2026-09-10 12:00 IST and 2026-09-11 12:00 IST.
const NOON_10 = Date.parse("2026-09-10T06:30:00Z");
const NOON_11 = Date.parse("2026-09-11T06:30:00Z");
const NOW = Date.parse("2026-10-07T05:00:00Z");

function usageResult(extra: Array<Record<string, unknown>> = []) {
  return {
    sessions: [
      {
        key: "agent:krishna:direct:asha",
        agentId: "krishna",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          dailyBreakdown: [
            { date: "2026-09-10", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
            { date: "2026-09-11", input: 0, output: 100_000, cacheRead: 0, cacheWrite: 0 },
            { date: "2026-09-12", ...zero },
          ],
        },
      },
      {
        key: "agent:krishna:main",
        agentId: "krishna",
        updatedAt: NOON_11,
        usage: { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0, lastActivity: NOON_11 },
      },
      { key: "agent:x:main", usage: null },
      ...extra,
    ],
  };
}

function setup(result: unknown = usageResult()) {
  const store = memoryStore();
  const request = vi.fn(async () => result);
  const log = vi.fn();
  const run = () =>
    backfillFromUsage({
      store,
      rateCard: () => DEFAULT_RATE_CARD,
      // SAFETY: the fake answers every method with the same sessions.usage-shaped result.
      request: request as never,
      lookups,
      now: () => NOW,
      log,
    });
  return { store, request, log, run };
}

describe("backfillFromUsage", () => {
  it("turns each session-day into a labelled backfill debit at that IST noon", async () => {
    const { store, request, run } = setup();
    const result = await run();
    expect(request).toHaveBeenCalledWith("sessions.usage", {
      range: "all",
      agentScope: "all",
      limit: 1000,
      timeZone: "Asia/Kolkata",
    });
    const rows = (await store.list({})).toReversed();
    expect(rows).toHaveLength(3);
    expect(result).toEqual({
      sessions: 2,
      days: 3,
      paise: rows.reduce((sum, r) => sum - r.amountPaise, 0),
    });
    expect(result.paise).toBeGreaterThan(0);
    const member = rows.filter((r) => r.label === "Chat — Asha");
    expect(member.map((r) => r.at).toSorted()).toEqual([NOON_10, NOON_11]);
    expect(member[0]).toMatchObject({
      kind: "debit",
      charge: "tokens",
      activity: "chat",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      source: "backfill",
      sessionKey: "agent:krishna:direct:asha",
      agentId: "krishna",
    });
    const main = rows.find((r) => r.label === "System — history");
    expect(main).toMatchObject({
      activity: "system",
      ref: "history",
      provider: "claude-cli",
      model: "unknown",
      inputTokens: 500_000,
      at: NOON_11,
      source: "backfill",
    });
    expect(rows.every((r) => r.amountPaise < 0 || r.unpriced)).toBe(true);
    expect((await store.getState()).backfillDoneAt).toBe(NOW);
  });

  it("is idempotent: a second run appends nothing", async () => {
    const { store, run } = setup();
    await run();
    const before = await store.balance();
    expect(await run()).toEqual({ sessions: 0, days: 0, paise: 0 });
    expect((await store.list({})).length).toBe(3);
    expect(await store.balance()).toBe(before);
  });

  it("leaves a day unmarked when its append fails so a rerun retries it", async () => {
    const { store, run } = setup();
    const append = vi.spyOn(store, "append").mockRejectedValueOnce(new Error("disk full"));
    await expect(run()).rejects.toThrow("disk full");
    append.mockRestore();
    expect((await run()).days).toBe(3);
  });

  it("warns when the 1000-session cap is hit and does not page", async () => {
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      key: `agent:a:main${i}`,
      usage: null,
    }));
    const { request, log, run } = setup({ sessions });
    await run();
    expect(request).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1000"));
  });
});
