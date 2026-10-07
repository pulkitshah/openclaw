import { describe, expect, it } from "vitest";
import type { NewEntry } from "./store.js";
import { memoryStore } from "./store.test-helpers.js";

const RATE = {
  inputInrPerM: 200,
  outputInrPerM: 2000,
  cacheReadInrPerM: 20,
  cacheWriteInrPerM: 400,
};
const debit = (over: Partial<NewEntry> = {}): NewEntry =>
  ({
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
  }) as NewEntry;
const hostingDebit = (over: Partial<NewEntry> = {}): NewEntry =>
  ({
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
  }) as NewEntry;

describe("WalletStore", () => {
  it("keeps a running balance across credits, debits and adjustments", async () => {
    const s = memoryStore();
    await s.append({
      kind: "credit",
      source: "manual",
      reference: "UPI-1",
      by: "admin",
      label: "Recharge",
      amountPaise: 500_000,
    });
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
  it("serializes concurrent appends so the balance_after chain is exact", async () => {
    const s = memoryStore();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => s.append(debit({ amountPaise: -(i + 1) }))),
    );
    const rows = (await s.list()).toReversed();
    let running = 0;
    for (const row of rows) {
      running += row.amountPaise;
      expect(row.balanceAfterPaise).toBe(running);
    }
    expect(await s.balance()).toBe(-325);
  });
  it("refuses a credit whose reference was already used", async () => {
    const s = memoryStore();
    await s.append({
      kind: "credit",
      source: "manual",
      reference: "UPI-9",
      by: "admin",
      label: "Recharge",
      amountPaise: 100,
    });
    await expect(
      s.append({
        kind: "credit",
        source: "manual",
        reference: "UPI-9",
        by: "admin",
        label: "Recharge",
        amountPaise: 100,
      }),
    ).rejects.toThrow(/duplicate reference/);
    expect(await s.balance()).toBe(100);
  });
  it("lists newest first with filters and summarizes by activity then ref", async () => {
    const s = memoryStore();
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
  });
  it("tracks state, backfill marks and hosting days", async () => {
    const s = memoryStore();
    expect(await s.getState()).toMatchObject({
      creditLimitPaise: 0,
      lowBalancePaise: 20_000,
      enforce: false,
    });
    await s.setState({ creditLimitPaise: 500_000, enforce: true });
    expect((await s.getState()).creditLimitPaise).toBe(500_000);
    expect(await s.markBackfill("agent:main:main", "2026-09-21")).toBe(true);
    expect(await s.markBackfill("agent:main:main", "2026-09-21")).toBe(false);
    expect(await s.hasBackfill("agent:main:main", "2026-09-21")).toBe(true);
    expect(await s.hasHosting("2026-10-07")).toBe(false);
    await s.append(hostingDebit());
    expect(await s.hasHosting("2026-10-07")).toBe(true);
  });
});
