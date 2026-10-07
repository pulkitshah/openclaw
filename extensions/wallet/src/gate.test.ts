import { describe, expect, it, vi } from "vitest";
import { createBeforeAgentRun, evaluateGate, exhaustedMessage } from "./gate.js";
import { createNotices } from "./notices.js";
import type { WalletStore } from "./store.js";
import { openTestStore } from "./store.test-helpers.js";

describe("evaluateGate", () => {
  it("allows while balance plus limit is positive, blocks at or below zero, ignores when not enforced", () => {
    const base = { creditLimitPaise: 500_000, lowBalancePaise: 20_000, enforce: true };
    expect(evaluateGate(base, -499_999)).toEqual({ allowed: true });
    expect(evaluateGate(base, -500_000)).toEqual({
      allowed: false,
      balancePaise: -500_000,
      creditLimitPaise: 500_000,
    });
    expect(evaluateGate({ ...base, enforce: false }, -9_999_999)).toEqual({ allowed: true });
  });
  it("names the contact, never a person", () => {
    expect(exhaustedMessage("TripIn Studio")).toBe(
      "Vasu is paused: the wallet balance is exhausted. Ask TripIn Studio to recharge, then send your message again.",
    );
  });
});

describe("before_agent_run", () => {
  const drain = (store: WalletStore, amountPaise: number) =>
    store.append({ kind: "adjustment", by: "t", label: "drain", amountPaise: -amountPaise });

  it("blocks with the message once per sender per stop, then silently, and lets a Duty run's own calls through", async () => {
    const store = await openTestStore();
    await store.setState({ enforce: true, creditLimitPaise: 0 });
    await drain(store, 1);
    const gate = createBeforeAgentRun({ store, contact: () => "TripIn Studio", log: vi.fn() });
    const ctx = { sessionKey: "agent:main:direct:asha" } as never;
    const first = await gate(
      { prompt: "hi", messages: [], senderId: "+911234567890" } as never,
      ctx,
    );
    expect(first).toEqual({
      outcome: "block",
      reason: "wallet_exhausted",
      message:
        "Vasu is paused: the wallet balance is exhausted. Ask TripIn Studio to recharge, then send your message again.",
    });
    const second = await gate(
      { prompt: "hi again", messages: [], senderId: "+911234567890" } as never,
      ctx,
    );
    expect(second).toEqual({ outcome: "block", reason: "wallet_exhausted" });
    // The gate only reads: the stop state belongs to notices.reconcile().
    expect((await store.getState()).stoppedSince).toBeUndefined();
    const duty = await gate(
      { prompt: "x", messages: [] } as never,
      { attribution: { kind: "duty", ref: "run-1", label: "l" } } as never,
    );
    expect(duty).toBeUndefined();
  });

  it("tells each sender once per stop episode, as reconcile opens and closes episodes", async () => {
    let clock = 1_000;
    const store = await openTestStore();
    const notices = createNotices({
      store,
      contact: () => "TripIn Studio",
      send: vi.fn(async () => {}),
      now: () => clock,
    });
    await store.setState({ enforce: true, creditLimitPaise: 0 });
    await drain(store, 1);
    await notices.reconcile();
    const gate = createBeforeAgentRun({ store, contact: () => "TripIn Studio", log: vi.fn() });
    const asha = { prompt: "hi", messages: [], senderId: "+911111111111" } as never;
    const ravi = { prompt: "hi", messages: [], senderId: "+912222222222" } as never;
    const message = async (e: never) =>
      ((await gate(e, {} as never)) as { message?: string }).message;
    expect(await message(asha)).toContain("Ask TripIn Studio");
    expect(await message(ravi)).toContain("Ask TripIn Studio");
    expect(await message(asha)).toBeUndefined();
    // A recharge closes the episode; a Duty call then runs before any chat call.
    const credit = await store.append({
      kind: "credit",
      source: "manual",
      reference: "r1",
      by: "t",
      label: "Recharge",
      amountPaise: 100,
    });
    await notices.afterCredit(credit as never);
    expect((await store.getState()).stoppedSince).toBeUndefined();
    await gate(
      { prompt: "x", messages: [] } as never,
      { attribution: { kind: "duty", ref: "r", label: "l" } } as never,
    );
    clock = 5_000;
    await drain(store, 100);
    await notices.reconcile();
    expect((await store.getState()).stoppedSince).toBe(5_000);
    expect(await message(asha)).toContain("Ask TripIn Studio");
    expect(await message(ravi)).toContain("Ask TripIn Studio");
    expect(await message(asha)).toBeUndefined();
  });

  it("passes when funded", async () => {
    const store = await openTestStore();
    await store.setState({ enforce: true, stoppedSince: 1 });
    await store.append({
      kind: "credit",
      source: "manual",
      reference: "r",
      by: "t",
      label: "Recharge",
      amountPaise: 100,
    });
    const gate = createBeforeAgentRun({ store, contact: () => "TripIn Studio", log: vi.fn() });
    expect(await gate({ prompt: "hi", messages: [] } as never, {} as never)).toBeUndefined();
  });

  it("returns at once when enforcement is off, without reading the balance", async () => {
    const store = await openTestStore();
    await drain(store, 1_000_000);
    const balance = vi.spyOn(store, "balance");
    const gate = createBeforeAgentRun({ store, contact: () => "TripIn Studio", log: vi.fn() });
    expect(await gate({ prompt: "hi", messages: [] } as never, {} as never)).toBeUndefined();
    expect(balance).not.toHaveBeenCalled();
  });

  it("allows the turn and logs when the store fails", async () => {
    const store = await openTestStore();
    vi.spyOn(store, "getState").mockRejectedValue(new Error("database is locked"));
    const log = vi.fn();
    const gate = createBeforeAgentRun({ store, contact: () => "TripIn Studio", log });
    expect(await gate({ prompt: "hi", messages: [] } as never, {} as never)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("database is locked"));
  });
});
