import { describe, expect, it } from "vitest";
import type { NewEntry, WalletEntry } from "./store.js";
import { openTestStore, reopenTestStore, testDbPath } from "./store.test-helpers.js";

const RATE = {
  inputInrPerM: 200,
  outputInrPerM: 2000,
  cacheReadInrPerM: 20,
  cacheWriteInrPerM: 400,
};
const debit = (over: Partial<Extract<NewEntry, { charge: "tokens" }>> = {}): NewEntry => ({
  kind: "debit",
  charge: "tokens",
  activity: "chat",
  ref: "agent:main:direct:asha",
  label: "Chat — Asha",
  provider: "claude-cli",
  model: "test-model",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  rate: RATE,
  unpriced: false,
  source: "live",
  amountPaise: -150,
  ...over,
});
const hostingDebit = (over: Partial<Extract<NewEntry, { charge: "service" }>> = {}): NewEntry => ({
  kind: "debit",
  charge: "service",
  activity: "hosting",
  ref: "hosting:2026-10-07",
  label: "Hosting — 7 Oct",
  service: "hosting",
  units: 1,
  unit: "day",
  unitRatePaise: 8_000,
  source: "live",
  amountPaise: -8_000,
  ...over,
});
const credit = (reference: string, amountPaise = 100): NewEntry => ({
  kind: "credit",
  source: "manual",
  reference,
  by: "admin",
  label: "Recharge",
  amountPaise,
});

function expectChain(rowsNewestFirst: WalletEntry[]): void {
  let running = 0;
  for (const row of rowsNewestFirst.toReversed()) {
    running += row.amountPaise;
    expect(row.balanceAfterPaise).toBe(running);
  }
}

describe("WalletStore", () => {
  it("keeps a running balance across credits, debits and adjustments", async () => {
    const s = await openTestStore();
    await s.append(credit("UPI-1", 500_000));
    await s.append(debit());
    const adj = await s.append({
      kind: "adjustment",
      by: "admin",
      label: "Goodwill",
      amountPaise: 1_000,
    });
    expect(adj.balanceAfterPaise).toBe(500_000 - 150 + 1_000);
    expect(await s.balance()).toBe(500_850);
  });

  it("round-trips every entry shape through the database", async () => {
    const s = await openTestStore();
    const tokens = await s.append(
      debit({ sessionKey: "agent:main:direct:asha", agentId: "main", runId: "r1", at: 5 }),
    );
    const service = await s.append(hostingDebit({ at: 6 }));
    const recharge = await s.append({ ...credit("UPI-7"), note: "first", at: 7 });
    expect(await s.list()).toEqual([recharge, service, tokens]);
    expect(tokens).toMatchObject({
      id: expect.stringMatching(/^\d+$/),
      rate: RATE,
      unpriced: false,
      sessionKey: "agent:main:direct:asha",
      runId: "r1",
    });
    expect(service).toMatchObject({ unitRatePaise: 8_000, units: 1, unit: "day" });
    expect(recharge).toMatchObject({ reference: "UPI-7", note: "first", by: "admin" });
  });

  it("chains balance_after exactly under 20 concurrent appends", async () => {
    const s = await openTestStore();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => s.append(debit({ amountPaise: -(i + 1) }))),
    );
    const rows = await s.list();
    expect(rows).toHaveLength(20);
    expectChain(rows);
    expect(await s.balance()).toBe(-210);
  });

  it("refuses a credit whose reference was already used, through the unique index", async () => {
    const s = await openTestStore();
    await s.append(credit("UPI-9"));
    await expect(s.append(credit("UPI-9"))).rejects.toThrow(/duplicate reference: UPI-9/);
    expect(await s.balance()).toBe(100);
    expect(await s.list()).toHaveLength(1);
  });

  it("refuses a second hosting row for the same day", async () => {
    const s = await openTestStore();
    await s.append(hostingDebit());
    await expect(s.append(hostingDebit())).rejects.toThrow(/hosting already posted/);
    expect(await s.balance()).toBe(-8_000);
  });

  it("lists newest appended first with filters and summarizes by activity then ref", async () => {
    const s = await openTestStore();
    await s.append(debit({ at: 1_000, amountPaise: -100 }));
    await s.append(
      debit({
        at: 2_000,
        amountPaise: -200,
        activity: "duty",
        ref: "run-1",
        label: "Book flight — Asha, 12 Oct",
        inputTokens: 100,
      }),
    );
    await s.append(
      debit({
        at: 3_000,
        amountPaise: -300,
        activity: "duty",
        ref: "run-1",
        label: "Book flight — Asha, 12 Oct",
        inputTokens: 100,
      }),
    );
    await s.append(hostingDebit({ at: 4_000 }));
    expect((await s.list()).map((e) => e.at)).toEqual([4_000, 3_000, 2_000, 1_000]);
    expect((await s.list({ activity: "duty" })).length).toBe(2);
    expect((await s.list({ from: 2_000, to: 3_000 })).length).toBe(2);
    const sum = await s.summarize({ from: 0, to: 5_000 });
    expect(sum.totalPaise).toBe(-8_600);
    expect(sum.buckets.map((b) => b.activity)).toEqual(["chat", "duty", "hosting"]);
    const duty = sum.buckets.find((b) => b.activity === "duty")!;
    expect(duty).toMatchObject({ paise: -500, tokens: 210 });
    expect(duty.activities).toEqual([
      { ref: "run-1", label: "Book flight — Asha, 12 Oct", paise: -500, tokens: 210, entries: 2 },
    ]);
    expect(await s.spendSince(0)).toEqual({ spentPaise: 8_600, days: 1 });
  });

  it("pages five rows that share one millisecond without skipping any", async () => {
    const s = await openTestStore();
    for (let i = 0; i < 5; i++) {
      await s.append(debit({ at: 42, amountPaise: -(i + 1) }));
    }
    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 5; page++) {
      const rows = await s.list({ limit: 2, ...(before !== undefined ? { before } : {}) });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) {
        break;
      }
      before = Number(rows.at(-1)!.id);
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("continues the chain from the greatest id after a restart, even when older rows carry newer `at`", async () => {
    const s = await openTestStore();
    const dbPath = testDbPath(s);
    const now = Date.now();
    await s.append(debit({ at: now + 60_000, amountPaise: -100 }));
    await s.append(debit({ at: now + 120_000, amountPaise: -200 }));
    const backfilled = await s.append(debit({ at: now - 86_400_000, amountPaise: -50 }));
    expect(backfilled.balanceAfterPaise).toBe(-350);
    await s.close();
    const reopened = await reopenTestStore(dbPath);
    expect(await reopened.balance()).toBe(-350);
    const next = await reopened.append(debit({ amountPaise: -10 }));
    expect(next.balanceAfterPaise).toBe(-360);
    expectChain(await reopened.list());
  });

  it("tracks state, backfill marks, live tokens and hosting days", async () => {
    const s = await openTestStore();
    expect(await s.getState()).toEqual({
      creditLimitPaise: 0,
      lowBalancePaise: 20_000,
      enforce: false,
    });
    await s.setState({ creditLimitPaise: 500_000, enforce: true, stoppedSince: 9 });
    expect(await s.getState()).toMatchObject({ creditLimitPaise: 500_000, stoppedSince: 9 });
    await s.setState({ stoppedSince: undefined });
    expect((await s.getState()).stoppedSince).toBeUndefined();
    expect((await s.getState()).enforce).toBe(true);
    expect(await s.ensureMeterStarted(10)).toBe(10);
    expect(await s.ensureMeterStarted(20)).toBe(10);
    expect(await s.markBackfill("agent:main:main", "2026-09-21")).toBe(true);
    expect(await s.markBackfill("agent:main:main", "2026-09-21")).toBe(false);
    expect(await s.hasBackfill("agent:main:main", "2026-09-21")).toBe(true);
    await s.append(debit({ at: 100, sessionKey: "agent:main:main", inputTokens: 7 }));
    await s.append(
      debit({ at: 100, sessionKey: "agent:main:main", inputTokens: 1_000, source: "backfill" }),
    );
    expect(await s.liveTokens("agent:main:main", 0, 200)).toEqual({
      input: 7,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(await s.hasHosting("2026-10-07")).toBe(false);
    await s.append(hostingDebit({ at: 1_000 }));
    expect(await s.hasHosting("2026-10-07")).toBe(true);
    expect(await s.hostingRefsSince(0)).toEqual(["hosting:2026-10-07"]);
    expect(await s.hostingRefsSince(2_000)).toEqual([]);
  });
});
