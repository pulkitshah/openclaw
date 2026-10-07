import { describe, expect, it, vi } from "vitest";
import { postHostingDebits } from "./hosting.js";
import { resolveRateCard } from "./money.js";
import { createNotices } from "./notices.js";
import { openTestStore } from "./store.test-helpers.js";

const DAY = 86_400_000;

describe("notices", () => {
  it("sends low once when crossing the line, stopped once at the gate, recharged on every credit", async () => {
    const store = await openTestStore();
    const send = vi.fn(async (_text: string) => {});
    await store.setState({ enforce: true, creditLimitPaise: 0, lowBalancePaise: 20_000 });
    const n = createNotices({ store, contact: () => "TripIn Studio", send, now: () => 1_000 });
    await store.append({
      kind: "credit",
      source: "manual",
      reference: "a",
      by: "t",
      label: "Recharge",
      amountPaise: 30_000,
    });
    await n.reconcile();
    expect(send).not.toHaveBeenCalled();
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -15_000 });
    await n.reconcile();
    await n.reconcile();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatch(/^Balance ₹150\.00/);
    expect(send.mock.calls[0]![0]).toContain("Recharge: TripIn Studio");
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -15_000 });
    await n.reconcile();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toBe("Vasu is paused — balance ₹0.00, allowance ₹0.00 used up.");
    expect((await store.getState()).stoppedSince).toBe(1_000);
    await n.reconcile();
    expect(send).toHaveBeenCalledTimes(2);
    const credit = await store.append({
      kind: "credit",
      source: "manual",
      reference: "UPI-4471",
      by: "t",
      label: "Recharge",
      amountPaise: 500_000,
    });
    await n.afterCredit(credit as never);
    expect(send.mock.calls[2]![0]).toBe(
      "Recharged ₹5,000.00 (UPI-4471). Balance ₹5,000.00. Vasu is back on.",
    );
    const after = await store.getState();
    expect([after.lastLowNoticeAt, after.stoppedSince, after.lastStopNoticeAt]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
  it("measures the low line against the credit limit, not zero", async () => {
    const store = await openTestStore();
    const send = vi.fn(async (_text: string) => {});
    await store.setState({ enforce: true, creditLimitPaise: 500_000, lowBalancePaise: 20_000 });
    const n = createNotices({ store, contact: () => "TripIn Studio", send });
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -470_000 });
    await n.reconcile();
    expect(send).not.toHaveBeenCalled();
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -15_000 });
    await n.reconcile();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("omits 'back on' when the desk was not stopped", async () => {
    const store = await openTestStore();
    const send = vi.fn(async (_text: string) => {});
    const n = createNotices({ store, contact: () => "TripIn Studio", send });
    const credit = await store.append({
      kind: "credit",
      source: "manual",
      reference: "r1",
      by: "t",
      label: "Recharge",
      amountPaise: 10_000,
    });
    await n.afterCredit(credit as never);
    expect(send).toHaveBeenCalledWith("Recharged ₹100.00 (r1). Balance ₹100.00.");
  });
  it("shows days left only with three distinct days of debits", async () => {
    const now = Date.UTC(2026, 9, 7, 6, 0, 0);
    const debit = (daysAgo: number) =>
      store.append({
        kind: "debit",
        charge: "service",
        activity: "hosting",
        ref: `hosting:${daysAgo}`,
        label: "Hosting",
        service: "hosting",
        units: 1,
        unit: "day",
        unitRatePaise: 1_000,
        amountPaise: -1_000,
        source: "live",
        at: now - daysAgo * DAY,
      });
    const store = await openTestStore();
    const send = vi.fn(async (_text: string) => {});
    await store.setState({ enforce: true, creditLimitPaise: 0, lowBalancePaise: 20_000 });
    const n = createNotices({ store, contact: () => "TripIn Studio", send, now: () => now });
    await store.append({
      kind: "credit",
      source: "manual",
      reference: "a",
      by: "t",
      label: "Recharge",
      amountPaise: 20_000,
    });
    await debit(0);
    await debit(1);
    await n.reconcile();
    expect(send.mock.calls[0]![0]).not.toContain("days at this week's rate");
    await store.setState({ lastLowNoticeAt: undefined });
    await debit(2);
    await n.reconcile();
    expect(send.mock.calls[1]![0]).toMatch(/about \d+ days at this week's rate/);
  });
  it("re-arms the low notice only when a credit lifts headroom above the low line", async () => {
    const store = await openTestStore();
    const send = vi.fn(async (_text: string) => {});
    await store.setState({ enforce: true, creditLimitPaise: 0, lowBalancePaise: 20_000 });
    const n = createNotices({ store, contact: () => "TripIn Studio", send });
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -1_000 });
    await store.setState({ lastLowNoticeAt: 1 });
    // Funded again but still below the line: no second low notice.
    const small = await store.append({
      kind: "credit",
      source: "manual",
      reference: "c1",
      by: "t",
      label: "Recharge",
      amountPaise: 6_000,
    });
    await n.afterCredit(small as never);
    expect((await store.getState()).lastLowNoticeAt).toBe(1);
    send.mockClear();
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -100 });
    await n.reconcile();
    expect(send).not.toHaveBeenCalled();
    // Lifted above the line: re-armed, the next crossing notifies again.
    const big = await store.append({
      kind: "credit",
      source: "manual",
      reference: "c2",
      by: "t",
      label: "Recharge",
      amountPaise: 50_000,
    });
    await n.afterCredit(big as never);
    expect((await store.getState()).lastLowNoticeAt).toBeUndefined();
    send.mockClear();
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -40_000 });
    await n.reconcile();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatch(/^Balance /);
  });
  it("reconcile clears a stop once a new limit allows it", async () => {
    const store = await openTestStore();
    const send = vi.fn(async (_text: string) => {});
    await store.setState({
      enforce: true,
      creditLimitPaise: 0,
      stoppedSince: 5,
      lastStopNoticeAt: 5,
    });
    const n = createNotices({ store, contact: () => "TripIn Studio", send });
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -100 });
    await n.reconcile();
    expect((await store.getState()).stoppedSince).toBe(5);
    await store.setState({ creditLimitPaise: 500_000 });
    await n.reconcile();
    expect((await store.getState()).stoppedSince).toBeUndefined();
  });
  it("sends no low or stopped notice while enforcement is off, even for a hosting debit", async () => {
    const store = await openTestStore();
    const send = vi.fn(async (_text: string) => {});
    const n = createNotices({ store, contact: () => "TripIn Studio", send });
    const posted = await postHostingDebits({
      store,
      rateCard: () => resolveRateCard({}),
      now: () => Date.UTC(2026, 9, 7, 6, 0),
      onChanged: () => {},
      afterDebit: n.reconcile,
    });
    expect(posted).toBe(1);
    expect(await store.balance()).toBe(-8_000);
    expect(send).not.toHaveBeenCalled();
    const state = await store.getState();
    expect([state.lastLowNoticeAt, state.stoppedSince]).toEqual([undefined, undefined]);
  });
  it("opens a stop episode once, and closes it when a settings change allows work again", async () => {
    let clock = 10;
    const store = await openTestStore();
    const send = vi.fn(async (_text: string) => {});
    const n = createNotices({ store, contact: () => "TripIn Studio", send, now: () => clock });
    await store.setState({ enforce: true, lowBalancePaise: 0 });
    await store.append({ kind: "adjustment", by: "t", label: "d", amountPaise: -100 });
    await n.reconcile();
    clock = 20;
    await n.reconcile();
    expect(await store.getState()).toMatchObject({ stoppedSince: 10, lastStopNoticeAt: 10 });
    expect(send).toHaveBeenCalledTimes(1);
    await store.setState({ enforce: false });
    await n.reconcile();
    const cleared = await store.getState();
    expect([cleared.stoppedSince, cleared.lastStopNoticeAt]).toEqual([undefined, undefined]);
  });
});
