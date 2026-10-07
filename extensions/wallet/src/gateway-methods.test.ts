import { describe, expect, it, vi } from "vitest";
import { harness } from "./gateway-methods.test-helpers.js";

const hasMessage = (error: unknown) => (error as { message: string }).message;

describe("wallet gateway methods", () => {
  it("registers each method under its scope", async () => {
    const { methods } = await harness();
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
      "wallet.backfill": "operator.admin",
    });
  });

  it("backfills from sessions.usage once and emits one changed", async () => {
    const request = async () => ({
      sessions: [
        {
          key: "agent:krishna:main",
          usage: {
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            lastActivity: 1_790_000_000_000,
          },
        },
      ],
    });
    // SAFETY: the fake answers sessions.usage only.
    const { call, emit, store } = await harness({ request: request as never });
    const first = await call("wallet.backfill");
    expect(first.ok).toBe(true);
    expect(first.result).toMatchObject({ sessions: 1, days: 1 });
    expect(await store.balance()).toBeLessThan(0);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "changed",
      expect.objectContaining({ kind: "debit", entryId: "" }),
    );
    const again = await call("wallet.backfill");
    expect(again.result).toEqual({ sessions: 0, days: 0, failed: 0, paise: 0 });
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("shares one run between overlapping wallet.backfill calls", async () => {
    const request = vi.fn(async () => ({
      sessions: [
        {
          key: "agent:krishna:main",
          usage: {
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            lastActivity: 1_790_000_000_000,
          },
        },
      ],
    }));
    // SAFETY: the fake answers sessions.usage only.
    const { call, store } = await harness({ request: request as never });
    const [a, b] = await Promise.all([call("wallet.backfill"), call("wallet.backfill")]);
    expect(request).toHaveBeenCalledTimes(1);
    expect((await store.list({})).length).toBe(1);
    expect(a.result).toEqual(b.result);
    expect(a.result).toMatchObject({ days: 1, failed: 0 });
  });

  it("still notifies when a backfill imported some days and failed others", async () => {
    const day = (date: string) => ({
      date,
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const request = async () => ({
      sessions: [
        {
          key: "agent:krishna:main",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            dailyBreakdown: [day("2026-09-10"), day("2026-09-11")],
          },
        },
      ],
    });
    // SAFETY: the fake answers sessions.usage only.
    const { call, emit, store } = await harness({ request: request as never });
    const original = store.append.bind(store);
    const append = vi.spyOn(store, "append");
    append.mockImplementationOnce(original);
    append.mockRejectedValueOnce(new Error("disk full"));
    const res = await call("wallet.backfill");
    expect(res.result).toMatchObject({ days: 1, failed: 1 });
    expect(emit).toHaveBeenCalledWith("changed", expect.objectContaining({ kind: "debit" }));
  });

  it("credits with a unique reference, emits changed, and refuses the duplicate", async () => {
    const { call, emit, store } = await harness();
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
    const { call, store } = await harness();
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
    const { call, store } = await harness();
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
    const { call } = await harness();
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
    const { call, store } = await harness();
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
    const body = page.result as {
      entries: Array<{ at: number; id: string }>;
      nextBefore?: number;
    };
    expect(body.entries.map((e) => e.at)).toEqual([3000, 2000]);
    expect(body.nextBefore).toBe(Number(body.entries[1]!.id));
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
    const { call, store } = await harness();
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
    const { call, store } = await harness();
    expect((await call("wallet.gate")).result).toEqual({ allowed: true });
    await store.setState({ enforce: true });
    const res = await call("wallet.gate");
    expect(res.result).toMatchObject({ allowed: false, balancePaise: 0, creditLimitPaise: 0 });
    expect((res.result as { message: string }).message).toMatch(/Balance exhausted.*Test Contact/);
  });
});
