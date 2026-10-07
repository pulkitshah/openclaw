import { describe, expect, it, vi } from "vitest";
import { createLlmOutputMeter } from "./meter.js";
import { resolveRateCard } from "./money.js";
import { openTestStore } from "./store.test-helpers.js";

const card = resolveRateCard({
  inrPerUsd: 100,
  multiplier: 2,
  tokenMarkup: 1,
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
  sessionName: async () => undefined,
  jobName: async () => undefined,
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
  it("stores marked-up token counts and prices them at the list rate", async () => {
    const store = await openTestStore();
    const listCard = resolveRateCard({ ...card, multiplier: 1, tokenMarkup: 1.3 });
    const meter = createLlmOutputMeter({
      store,
      rateCard: () => listCard,
      lookups,
      onUnrecorded: vi.fn(),
    });
    await meter(event({ input: 1_000, output: 100, cacheRead: 10_000, cacheWrite: 1_000 }), {
      agentId: "main",
    } as never);
    const [row] = await store.list();
    expect(row).toMatchObject({
      inputTokens: 1_300,
      outputTokens: 130,
      cacheReadTokens: 13_000,
      cacheWriteTokens: 1_300,
    });
    // list ₹/M at ₹100/$: input 100, output 1000, cacheRead 10, cacheWrite 200 → on the marked-up tokens
    // 1300×100 + 130×1000 + 13000×10 + 1300×200 = 650,000 µ₹ → ₹0.65 → 65 paise
    expect(row!.amountPaise).toBe(-65);
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
