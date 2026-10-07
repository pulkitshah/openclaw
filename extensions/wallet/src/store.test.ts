import { describe, expect, it } from "vitest";
import type { NewEntry } from "./store.js";
import { WalletStore } from "./store.js";
import { memoryKeyed, memoryStore } from "./store.test-helpers.js";

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
  it("trusts the ledger over a tampered balance cache", async () => {
    const entries = memoryKeyed<never>();
    const state = memoryKeyed<never>();
    const open = () => new WalletStore({ entries, state, backfill: memoryKeyed() });
    const first = open();
    await first.append({ kind: "adjustment", by: "admin", label: "Top up", amountPaise: 1_000 });
    await state.register("state", {
      creditLimitPaise: 0,
      lowBalancePaise: 0,
      enforce: false,
      balancePaise: 999_999,
    } as never);
    const reopened = open();
    expect(await reopened.balance()).toBe(1_000);
    const next = await reopened.append(debit({ amountPaise: -100 }));
    expect(next.balanceAfterPaise).toBe(900);
    expect(await reopened.balance()).toBe(900);
  });
  it("frees a credit reference when the row write fails, keeps it when only the cache write fails", async () => {
    const entries = memoryKeyed<never>();
    const state = memoryKeyed<never>();
    const s = new WalletStore({ entries, state, backfill: memoryKeyed() });
    const credit = {
      kind: "credit",
      source: "manual",
      reference: "UPI-5",
      by: "admin",
      label: "Recharge",
      amountPaise: 100,
    } as const;
    const realRegister = entries.register;
    entries.register = async () => {
      throw new Error("disk full");
    };
    await expect(s.append(credit)).rejects.toThrow(/disk full/);
    entries.register = realRegister;
    await s.append(credit);
    expect(await s.balance()).toBe(100);

    const realState = state.register;
    state.register = async () => {
      throw new Error("cache down");
    };
    const credit2 = { ...credit, reference: "UPI-6" };
    await expect(s.append(credit2)).rejects.toThrow(/cache down/);
    state.register = realState;
    await expect(s.append(credit2)).rejects.toThrow(/duplicate reference/);
    expect(await s.balance()).toBe(200);
  });
  it("chains balance_after in posting order, including backfill-shaped rows and restarts", async () => {
    const entries = memoryKeyed<never>();
    const state = memoryKeyed<never>();
    const open = () => new WalletStore({ entries, state, backfill: memoryKeyed() });
    const s = open();
    const now = Date.now();
    await s.append(debit({ at: now, amountPaise: -100 }));
    await s.append(debit({ at: now + 1, amountPaise: -200 }));
    const backfilled = await s.append(debit({ at: now - 86_400_000, amountPaise: -50 }));
    expect(backfilled.balanceAfterPaise).toBe(-350);
    expect(await s.balance()).toBe(-350);
    const restarted = open();
    expect(await restarted.balance()).toBe(-350);
    expect((await restarted.append(debit({ amountPaise: -10 }))).balanceAfterPaise).toBe(-360);
  });
});
