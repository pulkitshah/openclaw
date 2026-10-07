import { describe, expect, it, vi } from "vitest";
import { backfillFromUsage } from "./backfill.js";
import { resolveRateCard } from "./money.js";
import type { TokensDebit } from "./store.js";
import { openTestStore } from "./store.test-helpers.js";

// ₹200/M input, ₹2000/M output.
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
const RATE = {
  inputInrPerM: 200,
  outputInrPerM: 2000,
  cacheReadInrPerM: 20,
  cacheWriteInrPerM: 400,
};
const lookups = {
  memberName: async () => undefined,
  groupName: async () => undefined,
  mailAgentIds: () => ["duties-mail"],
};
const IST = { mode: "specific", timeZone: "Asia/Kolkata", utcOffset: "UTC+5:30" };
// 12:00 IST on 10, 11 Sep 2026.
const NOON_10 = Date.parse("2026-09-10T06:30:00Z");
const NOON_11 = Date.parse("2026-09-11T06:30:00Z");
const NOW = Date.parse("2026-10-07T05:00:00Z");

type Tokens = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
const totals = (t: Tokens) => {
  const full = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...t };
  const totalTokens = full.input + full.output + full.cacheRead + full.cacheWrite;
  return { ...full, totalTokens, totalCost: 0, missingCostEntries: 0 };
};
/** One agent-day as `sessions.usage` returns it for startDate = endDate = day and one agentId. */
const agentDay = (models: Array<[string, string, Tokens]>, channelTokens = 0) => {
  const byModel = models.map(([provider, model, t]) => ({
    provider,
    model,
    count: 1,
    totals: totals(t),
  }));
  const agentTotal = totals({});
  for (const m of byModel) {
    agentTotal.totalTokens += m.totals.totalTokens;
  }
  return {
    sessions: [],
    totals: agentTotal,
    aggregates: {
      byModel,
      byChannel: channelTokens
        ? [{ channel: "whatsapp", totals: { ...totals({}), totalTokens: channelTokens } }]
        : [],
    },
  };
};
const overview = (days: Array<[string, number]>, agents: string[]) => ({
  sessions: [],
  aggregates: {
    daily: days.map(([date, tokens]) => ({ date, tokens, cost: 0, messages: 1 })),
    byAgent: agents.map((agentId) => ({ agentId, totals: totals({}) })),
  },
});

const MIRROR: [string, string, Tokens] = ["openclaw", "delivery-mirror", {}];
const PER_DAY: Record<string, Record<string, unknown>> = {
  // main: 1M input + 100k output = ₹400, half through WhatsApp.
  "2026-09-10": {
    main: agentDay(
      [["claude-cli", "test-model", { input: 1_000_000, output: 100_000 }], MIRROR],
      550_000,
    ),
    "duties-mail": agentDay([["claude-cli", "test-model", { input: 500_000 }]]),
  },
  // main: 3M input = ₹600, a third through WhatsApp.
  "2026-09-11": {
    main: agentDay([["claude-cli", "test-model", { input: 3_000_000 }], MIRROR], 1_000_000),
    "duties-mail": agentDay([["claude-cli", "test-model", { input: 500_000 }]]),
  },
};

async function setup(opts?: {
  days?: Array<[string, number]>;
  agents?: string[];
  perDay?: Record<string, Record<string, unknown>>;
}) {
  const store = await openTestStore();
  const days = opts?.days ?? [
    ["2026-09-09", 0],
    ["2026-09-10", 2_200_000],
    ["2026-09-11", 4_000_000],
  ];
  const agents = opts?.agents ?? ["main", "duties-mail"];
  const perDay = opts?.perDay ?? PER_DAY;
  const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (params.range === "all") {
      return overview(days, agents);
    }
    const found = perDay[String(params.startDate)]?.[String(params.agentId)];
    return found ?? agentDay([]);
  });
  const log = vi.fn();
  const run = () =>
    backfillFromUsage({
      store,
      rateCard: () => card,
      // SAFETY: the fake answers sessions.usage with the shapes the backfill reads.
      request: request as never,
      lookups,
      now: () => NOW,
      log,
    });
  return { store, request, log, run };
}

const tokenRows = async (store: Awaited<ReturnType<typeof openTestStore>>) =>
  (await store.list({})).filter(
    (r): r is TokensDebit => r.kind === "debit" && r.charge === "tokens",
  );

describe("backfillFromUsage", () => {
  it("imports each agent-day per model, splitting non-mail agents into chat and system", async () => {
    const { store, request, run } = await setup();
    const result = await run();
    expect(result).toEqual({ days: 2, agents: 2, failed: 0, paise: 120_000 });
    expect(request).toHaveBeenCalledWith("sessions.usage", {
      range: "all",
      agentScope: "all",
      limit: 1,
      ...IST,
    });
    expect(request).toHaveBeenCalledWith("sessions.usage", {
      startDate: "2026-09-10",
      endDate: "2026-09-10",
      agentId: "main",
      limit: 1,
      ...IST,
    });
    // A day with no tokens is never read.
    expect(request).not.toHaveBeenCalledWith(
      "sessions.usage",
      expect.objectContaining({ startDate: "2026-09-09" }),
    );
    expect(request).toHaveBeenCalledTimes(5);

    const rows = await tokenRows(store);
    expect(rows).toHaveLength(6);
    // Zero-token models are skipped.
    expect(rows.every((r) => r.model === "test-model")).toBe(true);
    const shape = (r: TokensDebit) => [
      r.label,
      r.activity,
      r.ref,
      r.at,
      r.inputTokens,
      r.outputTokens,
      r.amountPaise,
    ];
    expect(rows.map(shape).toSorted()).toEqual(
      [
        [
          "Chat — 10 Sep (history)",
          "chat",
          "backfill:2026-09-10:main:chat",
          NOON_10,
          500_000,
          50_000,
          -20_000,
        ],
        [
          "System — 10 Sep (history)",
          "system",
          "backfill:2026-09-10:main:system",
          NOON_10,
          500_000,
          50_000,
          -20_000,
        ],
        [
          "Mail — 10 Sep (history)",
          "mail",
          "backfill:2026-09-10:duties-mail",
          NOON_10,
          500_000,
          0,
          -10_000,
        ],
        [
          "Chat — 11 Sep (history)",
          "chat",
          "backfill:2026-09-11:main:chat",
          NOON_11,
          1_000_000,
          0,
          -20_000,
        ],
        [
          "System — 11 Sep (history)",
          "system",
          "backfill:2026-09-11:main:system",
          NOON_11,
          2_000_000,
          0,
          -40_000,
        ],
        [
          "Mail — 11 Sep (history)",
          "mail",
          "backfill:2026-09-11:duties-mail",
          NOON_11,
          500_000,
          0,
          -10_000,
        ],
      ].toSorted(),
    );
    expect(rows[0]).toMatchObject({
      source: "backfill",
      provider: "claude-cli",
      model: "test-model",
      unpriced: false,
      rate: RATE,
    });
    expect(rows.every((r) => r.sessionKey === undefined)).toBe(true);
    expect(rows.filter((r) => r.agentId === "main")).toHaveLength(4);
    // The chat and system rows of main sum exactly to its model totals per day.
    for (const [day, input, output, paise] of [
      [NOON_10, 1_000_000, 100_000, -40_000],
      [NOON_11, 3_000_000, 0, -60_000],
    ]) {
      const main = rows.filter((r) => r.agentId === "main" && r.at === day);
      expect(main.reduce((s, r) => s + r.inputTokens, 0)).toBe(input);
      expect(main.reduce((s, r) => s + r.outputTokens, 0)).toBe(output);
      expect(main.reduce((s, r) => s + r.amountPaise, 0)).toBe(paise);
    }
    // Balance chain: each row's balance follows from the previous one in append order.
    const ordered = (await store.list({})).toSorted((a, b) => Number(a.id) - Number(b.id));
    let balance = 0;
    for (const row of ordered) {
      balance += row.amountPaise;
      expect(row.balanceAfterPaise).toBe(balance);
    }
    expect(await store.balance()).toBe(-120_000);
    expect(await store.hasBackfill("agent:main", "2026-09-11")).toBe(true);
    expect(await store.getState()).toMatchObject({
      backfillDoneAt: NOW,
      backfillResult: { days: 2, agents: 2, failed: 0, paise: 120_000 },
    });
  });

  it("is one-time: a second run returns the first result with alreadyDone and writes nothing", async () => {
    const { store, request, run } = await setup();
    const first = await run();
    const calls = request.mock.calls.length;
    expect(await run()).toEqual({ ...first, alreadyDone: true });
    expect(request).toHaveBeenCalledTimes(calls);
    expect(await tokenRows(store)).toHaveLength(6);
    expect(await store.balance()).toBe(-120_000);
  });

  it.each([
    [400, 600],
    [1_500, 0],
  ])(
    "on the cutover day imports usage minus %i live tokens (%i), and skips later days",
    async (liveInput, imported) => {
      const day = agentDay([["claude-cli", "test-model", { input: 1_000 }]]);
      const { store, request, run } = await setup({
        days: [
          ["2026-09-10", 1_000],
          ["2026-09-11", 1_000],
          ["2026-09-12", 1_000],
        ],
        agents: ["main"],
        perDay: {
          "2026-09-10": { main: day },
          "2026-09-11": { main: day },
          "2026-09-12": { main: day },
        },
      });
      // The meter started at 09:00 IST on 11 Sep and recorded live tokens for main that day.
      await store.ensureMeterStarted(Date.parse("2026-09-11T03:30:00Z"));
      const live = {
        kind: "debit" as const,
        charge: "tokens" as const,
        activity: "chat" as const,
        ref: "agent:main:direct:asha",
        label: "Chat — Asha",
        provider: "claude-cli",
        model: "test-model",
        inputTokens: liveInput,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        rate: RATE,
        unpriced: false,
        source: "live" as const,
        agentId: "main",
        amountPaise: 0,
        at: NOON_11,
      };
      await store.append(live);
      // Live tokens of another agent are not subtracted from main.
      await store.append({
        ...live,
        agentId: "duties-mail",
        inputTokens: 1_000,
      });
      const result = await run();
      expect(result.failed).toBe(0);
      const backfilled = (await tokenRows(store)).filter((r) => r.source === "backfill");
      expect(backfilled.map((r) => [r.at, r.inputTokens]).toSorted()).toEqual(
        [[NOON_10, 1_000], ...(imported ? [[NOON_11, imported]] : [])].toSorted(),
      );
      expect(await store.hasBackfill("agent:main", "2026-09-11")).toBe(true);
      expect(await store.hasBackfill("agent:main", "2026-09-12")).toBe(false);
      expect(request).not.toHaveBeenCalledWith(
        "sessions.usage",
        expect.objectContaining({ startDate: "2026-09-12" }),
      );
    },
  );

  it("logs a failed agent-day, keeps going, leaves it unmarked, and a rerun imports it", async () => {
    const { store, request, log, run } = await setup();
    const answer = request.getMockImplementation();
    request.mockImplementation(async (method, params) => {
      if (params.startDate === "2026-09-11" && params.agentId === "duties-mail") {
        throw new Error("usage read failed");
      }
      return answer!(method, params);
    });
    const first = await run();
    expect(first).toEqual({ days: 2, agents: 2, failed: 1, paise: 110_000 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("usage read failed"));
    expect(await store.hasBackfill("agent:duties-mail", "2026-09-11")).toBe(false);
    expect(await store.hasBackfill("agent:main", "2026-09-11")).toBe(true);
    expect((await store.getState()).backfillDoneAt).toBeUndefined();
    expect(await tokenRows(store)).toHaveLength(5);

    request.mockImplementation(answer!);
    const second = await run();
    expect(second).toEqual({ days: 1, agents: 1, failed: 0, paise: 10_000 });
    expect(await tokenRows(store)).toHaveLength(6);
    expect(await store.balance()).toBe(-120_000);
    expect((await store.getState()).backfillDoneAt).toBe(NOW);
  });
});
