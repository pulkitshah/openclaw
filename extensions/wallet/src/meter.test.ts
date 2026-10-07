import { describe, expect, it, vi } from "vitest";
import { createLlmOutputMeter } from "./meter.js";
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
const lookups = {
  memberName: async () => "Asha",
  groupName: async () => undefined,
  mailAgentIds: () => ["duties-mail"],
};
const event = (usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }) =>
  ({
    runId: "r1",
    sessionId: "s1",
    provider: "claude-cli",
    model: "test-model",
    assistantTexts: [],
    ...(usage ? { usage } : {}),
  }) as never;

describe("llm_output meter", () => {
  it("writes one priced tokens debit per model call with attribution", async () => {
    const store = await openTestStore();
    const afterAppend = vi.fn(async () => {});
    const onDebit = vi.fn();
    const meter = createLlmOutputMeter({
      store,
      rateCard: () => card,
      lookups,
      onUnrecorded: vi.fn(),
      afterAppend,
      onDebit,
    });
    await meter(event({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), {
      sessionKey: "agent:main:direct:asha",
      agentId: "main",
      trigger: "user",
    } as never);
    const [row] = await store.list();
    expect(row).toMatchObject({
      kind: "debit",
      charge: "tokens",
      amountPaise: -20_000,
      activity: "chat",
      label: "Chat — Asha",
      provider: "claude-cli",
      model: "test-model",
      inputTokens: 1_000_000,
      sessionKey: "agent:main:direct:asha",
      agentId: "main",
      runId: "r1",
      source: "live",
      unpriced: false,
    });
    expect(await store.balance()).toBe(-20_000);
    expect(afterAppend).toHaveBeenCalledTimes(1);
    expect(onDebit).toHaveBeenCalledWith(row!.id);
  });
  it("writes nothing for a call with no usage or all-zero usage, and never throws", async () => {
    const store = await openTestStore();
    const meter = createLlmOutputMeter({
      store,
      rateCard: () => card,
      lookups,
      onUnrecorded: vi.fn(),
    });
    await meter(event(undefined), {} as never);
    await meter(event({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), {} as never);
    expect(await store.list()).toEqual([]);
  });
  it("reports a failed write instead of throwing into the hook", async () => {
    const store = await openTestStore();
    store.append = async () => {
      throw new Error("disk full");
    };
    const onUnrecorded = vi.fn();
    const meter = createLlmOutputMeter({ store, rateCard: () => card, lookups, onUnrecorded });
    await expect(
      meter(event({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }), {} as never),
    ).resolves.toBeUndefined();
    expect(onUnrecorded).toHaveBeenCalledTimes(1);
  });
  it("reports a failing afterAppend through onUnrecorded", async () => {
    const store = await openTestStore();
    const onUnrecorded = vi.fn();
    const meter = createLlmOutputMeter({
      store,
      rateCard: () => card,
      lookups,
      onUnrecorded,
      afterAppend: async () => {
        throw new Error("notice failed");
      },
    });
    await meter(event({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }), {} as never);
    expect(onUnrecorded).toHaveBeenCalledTimes(1);
  });
});
