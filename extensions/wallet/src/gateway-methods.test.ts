import { describe, expect, it } from "vitest";
import { harness } from "./gateway-methods.test-helpers.js";

const hasMessage = (error: unknown) => (error as { message: string }).message;

describe("wallet gateway methods", () => {
  it("registers each method under its scope", () => {
    const { methods } = harness();
    const scopes = Object.fromEntries([...methods].map(([name, m]) => [name, m.scope]));
    expect(scopes).toEqual({
      "wallet.get": "operator.read",
      "wallet.ledger": "operator.read",
      "wallet.export": "operator.read",
      "wallet.gate": "operator.read",
      "wallet.charge": "operator.write",
      "wallet.credit": "operator.admin",
      "wallet.adjust": "operator.admin",
      "wallet.settings": "operator.admin",
    });
  });

  it("credits with a unique reference, emits changed, and refuses the duplicate", async () => {
    const { call, emit, store } = harness();
    const first = await call("wallet.credit", { amountPaise: 500_000, reference: "UTR-1" });
    expect(first.ok).toBe(true);
    expect(await store.balance()).toBe(500_000);
    const dup = await call("wallet.credit", { amountPaise: 500_000, reference: "UTR-1" });
    expect(dup.ok).toBe(false);
    expect(hasMessage(dup.error)).toMatch(/duplicate reference/);
    expect(await store.balance()).toBe(500_000);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "changed",
      expect.objectContaining({ balancePaise: 500_000, kind: "credit" }),
    );
    const bad = await call("wallet.credit", { amountPaise: 10.5, reference: "UTR-2" });
    expect(bad.ok).toBe(false);
  });

  it("adjusts signed and records who did it", async () => {
    const { call, store } = harness();
    await call("wallet.credit", { amountPaise: 10_000, reference: "UTR-1" });
    const res = await call(
      "wallet.adjust",
      { amountPaise: -2_500, note: "refund" },
      { profileId: "p-1" },
    );
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({
      entry: { kind: "adjustment", amountPaise: -2_500, by: "p-1" },
    });
    expect(await store.balance()).toBe(7_500);
    const anon = await call("wallet.adjust", { amountPaise: 100, note: "fix" });
    expect(anon.result).toMatchObject({ entry: { by: "operator" } });
    expect((await call("wallet.adjust", { amountPaise: 0, note: "x" })).ok).toBe(false);
    expect((await call("wallet.adjust", { amountPaise: 5, note: "" })).ok).toBe(false);
  });

  it("prices a service charge and refuses unknown services", async () => {
    const { call, store } = harness();
    const res = await call("wallet.charge", { service: "apify", units: 10 });
    expect(res.result).toMatchObject({
      entry: {
        kind: "debit",
        charge: "service",
        activity: "integration",
        ref: "apify",
        amountPaise: -500,
      },
    });
    expect(await store.balance()).toBe(-500);
    const unknown = await call("wallet.charge", { service: "nope", units: 1 });
    expect(unknown.ok).toBe(false);
    expect(hasMessage(unknown.error)).toBe("unknown service: nope");
  });

  it("reports balance, summary, days-left and contact in wallet.get", async () => {
    const { call } = harness();
    await call("wallet.credit", { amountPaise: 100_000, reference: "UTR-1" });
    await call("wallet.charge", { service: "apify", units: 10 });
    const res = await call("wallet.get");
    expect(res.result).toMatchObject({
      balancePaise: 99_500,
      daysLeft: null,
      contact: "Test Contact",
      unrecorded: 0,
      state: { enforce: false },
      summary: { totalPaise: -500 },
    });
    const body = res.result as { period: { from: number; to: number }; rateCard: unknown };
    expect(body.period.from).toBeLessThan(body.period.to);
    expect(body.rateCard).toBeTruthy();
  });

  it("pages the ledger newest first and exports CSV with a header row", async () => {
    const { call, store } = harness();
    for (let i = 1; i <= 3; i++) {
      await store.append({
        kind: "credit",
        source: "manual",
        reference: i === 2 ? 'R,"2"' : `R${i}`,
        by: "operator",
        amountPaise: i * 100,
        label: "Recharge",
        at: i * 1000,
      });
    }
    const page = await call("wallet.ledger", { limit: 2 });
    const body = page.result as { entries: Array<{ at: number }>; nextBefore?: number };
    expect(body.entries.map((e) => e.at)).toEqual([3000, 2000]);
    expect(body.nextBefore).toBe(2000);
    const rest = await call("wallet.ledger", { limit: 2, before: body.nextBefore });
    const restBody = rest.result as { entries: unknown[]; nextBefore?: number };
    expect(restBody.entries).toHaveLength(1);
    expect(restBody.nextBefore).toBeUndefined();
    const { csv } = (await call("wallet.export", {})).result as { csv: string };
    const lines = csv.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(
      "at,kind,charge,activity,label,model/service,tokens,amount ₹,balance after ₹,reference/note",
    );
    expect(lines[2]).toContain('"R,""2"""');
  });

  it("settings re-evaluate the stop: raising the limit un-pauses", async () => {
    const { call, store } = harness();
    await store.setState({ enforce: true, stoppedSince: 1, lastStopNoticeAt: 1 });
    const res = await call("wallet.settings", { creditLimitPaise: 500_000 });
    expect(res.ok).toBe(true);
    expect((res.result as { state: { stoppedSince?: number } }).state.stoppedSince).toBeUndefined();
    expect((await store.getState()).stoppedSince).toBeUndefined();
    const probe = await call("wallet.settings", {});
    expect(probe.ok).toBe(true);
    expect((await call("wallet.settings", { creditLimitPaise: -1 })).ok).toBe(false);
  });

  it("wallet.gate mirrors evaluateGate and includes the exhausted message", async () => {
    const { call, store } = harness();
    expect((await call("wallet.gate")).result).toEqual({ allowed: true });
    await store.setState({ enforce: true });
    const res = await call("wallet.gate");
    expect(res.result).toMatchObject({ allowed: false, balancePaise: 0, creditLimitPaise: 0 });
    expect((res.result as { message: string }).message).toMatch(/Balance exhausted.*Test Contact/);
  });
});
