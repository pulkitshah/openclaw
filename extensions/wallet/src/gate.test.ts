import { describe, expect, it, vi } from "vitest";
import { createBeforeAgentRun, evaluateGate, exhaustedMessage } from "./gate.js";
import { memoryStore } from "./store.test-helpers.js";

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
    expect(
      exhaustedMessage(
        { allowed: false, balancePaise: -31_200, creditLimitPaise: 50_000 },
        "TripIn Studio",
      ),
    ).toBe(
      "Balance exhausted (₹−312.00 of ₹500.00 allowed). Ask TripIn Studio to recharge — your message is kept and will be answered after recharge.",
    );
  });
});

describe("before_agent_run", () => {
  it("blocks with the message once per sender per stop, then silently, and lets a Duty run's own calls through", async () => {
    const store = memoryStore();
    await store.setState({ enforce: true, creditLimitPaise: 0 });
    await store.append({ kind: "adjustment", by: "t", label: "drain", amountPaise: -1 });
    const onStopped = vi.fn(async () => {});
    const gate = createBeforeAgentRun({ store, contact: () => "TripIn Studio", onStopped });
    const ctx = { sessionKey: "agent:main:direct:asha" } as never;
    const first = await gate(
      { prompt: "hi", messages: [], senderId: "+911234567890" } as never,
      ctx,
    );
    expect(first).toMatchObject({ outcome: "block", reason: "wallet_exhausted" });
    expect((first as { message?: string }).message).toContain("Ask TripIn Studio");
    const second = await gate(
      { prompt: "hi again", messages: [], senderId: "+911234567890" } as never,
      ctx,
    );
    expect(second).toMatchObject({ outcome: "block", reason: "wallet_exhausted" });
    expect((second as { message?: string }).message).toBeUndefined();
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect((await store.getState()).stoppedSince).toBeTypeOf("number");
    const duty = await gate(
      { prompt: "x", messages: [] } as never,
      { attribution: { kind: "duty", ref: "run-1", label: "l" } } as never,
    );
    expect(duty).toBeUndefined();
  });
  it("passes when funded", async () => {
    const store = memoryStore();
    await store.setState({ enforce: true, stoppedSince: 1 });
    await store.append({
      kind: "credit",
      source: "manual",
      reference: "r",
      by: "t",
      label: "Recharge",
      amountPaise: 100,
    });
    const gate = createBeforeAgentRun({
      store,
      contact: () => "TripIn Studio",
      onStopped: vi.fn(async () => {}),
    });
    expect(await gate({ prompt: "hi", messages: [] } as never, {} as never)).toBeUndefined();
  });
});
