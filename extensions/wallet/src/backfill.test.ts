import { describe, expect, it, vi } from "vitest";
import { backfillFromUsage } from "./backfill.js";
import { resolveRateCard } from "./money.js";
import { openTestStore } from "./store.test-helpers.js";

const card = resolveRateCard({
  inrPerUsd: 100,
  multiplier: 2,
  models: {
    "test-model": {
      inputUsdPerM: 1,
      outputUsdPerM: 10,
      cacheReadUsdPerM: 0.1,
      cacheWriteUsdPerM: 2,
    },
  },
});
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
        model: "test-model",
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
        model: "test-model",
        updatedAt: NOON_11,
        usage: { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0, lastActivity: NOON_11 },
      },
      { key: "agent:x:main", usage: null },
      ...extra,
    ],
  };
}

async function setup(result: unknown = usageResult()) {
  const store = await openTestStore();
  const request = vi.fn(async () => result);
  const log = vi.fn();
  const run = () =>
    backfillFromUsage({
      store,
      rateCard: () => card,
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
    const { store, request, run } = await setup();
    const result = await run();
    expect(request).toHaveBeenCalledWith("sessions.usage", {
      range: "all",
      agentScope: "all",
      limit: 1000,
      timeZone: "Asia/Kolkata",
    });
    const rows = (await store.list({})).toReversed();
    expect(rows).toHaveLength(3);
    // ₹200/M input, ₹2000/M output: 1M input = ₹200, 100k output = ₹200, 500k input = ₹100.
    expect(result).toEqual({ sessions: 2, days: 3, failed: 0, paise: 50_000 });
    const rate = {
      inputInrPerM: 200,
      outputInrPerM: 2000,
      cacheReadInrPerM: 20,
      cacheWriteInrPerM: 400,
    };
    const member = rows.filter((r) => r.label === "Chat — Asha");
    expect(member.map((r) => [r.at, r.amountPaise]).toSorted()).toEqual([
      [NOON_10, -20_000],
      [NOON_11, -20_000],
    ]);
    expect(member[0]).toMatchObject({
      kind: "debit",
      charge: "tokens",
      activity: "chat",
      provider: "anthropic",
      model: "test-model",
      source: "backfill",
      sessionKey: "agent:krishna:direct:asha",
      agentId: "krishna",
      rate,
      unpriced: false,
    });
    expect(await store.balance()).toBe(-50_000);
    const main = rows.find((r) => r.label === "System — history");
    expect(main).toMatchObject({
      activity: "system",
      ref: "history",
      provider: "claude-cli",
      model: "test-model",
      inputTokens: 500_000,
      amountPaise: -10_000,
      at: NOON_11,
      source: "backfill",
      rate,
    });
    expect((await store.getState()).backfillDoneAt).toBe(NOW);
  });

  it("is idempotent: a second run appends nothing", async () => {
    const { store, run } = await setup();
    await run();
    const before = await store.balance();
    expect(await run()).toEqual({ sessions: 0, days: 0, failed: 0, paise: 0 });
    expect((await store.list({})).length).toBe(3);
    expect(await store.balance()).toBe(before);
  });

  it("logs a failed day, keeps going, leaves it unmarked, and a rerun imports it", async () => {
    const { store, log, run } = await setup();
    const original = store.append.bind(store);
    const append = vi.spyOn(store, "append");
    append.mockImplementationOnce(original);
    append.mockRejectedValueOnce(new Error("disk full"));
    const first = await run();
    append.mockRestore();
    expect(first).toMatchObject({ days: 2, failed: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect((await store.list({})).length).toBe(2);
    expect(await store.hasBackfill("agent:krishna:direct:asha", "2026-09-11")).toBe(false);
    const second = await run();
    expect(second).toMatchObject({ days: 1, failed: 0 });
    expect((await store.list({})).length).toBe(3);
  });

  it("warns when the 1000-session cap is hit and does not page", async () => {
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      key: `agent:a:main${i}`,
      usage: null,
    }));
    const { request, log, run } = await setup({ sessions });
    await run();
    expect(request).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("1000"));
  });
});
