import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_CARD,
  formatInr,
  modelRates,
  priceService,
  priceTokens,
  resolveRateCard,
} from "./money.js";

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
  services: { apify: { unit: "compute-unit", inrPerUnit: 0.5 } },
});

describe("priceTokens", () => {
  it("prices tokens per million at usd × inrPerUsd × multiplier, in paise, half-up", () => {
    // 1M input @ $1 → $1 → ₹200 → 20000 paise; 100k output @ $10/M → $1 → ₹200 → 20000 paise
    const price = priceTokens(card, "claude-cli", "test-model", {
      input: 1_000_000,
      output: 100_000,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(price.paise).toBe(40_000);
    expect(price.unpriced).toBe(false);
    expect(price.rate).toEqual({
      inputInrPerM: 200,
      outputInrPerM: 2000,
      cacheReadInrPerM: 20,
      cacheWriteInrPerM: 400,
    });
  });
  it("rounds half-up once per entry, never per token class", () => {
    // 3 input tokens @ ₹200/M = 0.0006 paise... use a case landing on .5: 2500 input @ ₹200/M = 50 paise exactly; 2502 → 50.04 → 50
    expect(
      priceTokens(card, "x", "test-model", { input: 2_502, output: 0, cacheRead: 0, cacheWrite: 0 })
        .paise,
    ).toBe(50);
    expect(
      priceTokens(card, "x", "test-model", { input: 2_525, output: 0, cacheRead: 0, cacheWrite: 0 })
        .paise,
    ).toBe(51);
  });
  it("matches provider-qualified ids before bare model ids and falls back flagged", () => {
    const qualified = resolveRateCard({
      ...card,
      models: {
        ...card.models,
        "anthropic/test-model": {
          inputUsdPerM: 99,
          outputUsdPerM: 99,
          cacheReadUsdPerM: 99,
          cacheWriteUsdPerM: 99,
        },
      },
    });
    expect(modelRates(qualified, "anthropic", "test-model").rates.inputUsdPerM).toBe(99);
    expect(modelRates(qualified, "claude-cli", "test-model").rates.inputUsdPerM).toBe(1);
    const unknown = modelRates(card, "x", "never-heard");
    expect(unknown.unpriced).toBe(true);
    expect(unknown.rates).toEqual(card.fallback);
  });
});

describe("model aliases", () => {
  it("prices the claude-cli `sonnet` alias at Sonnet, and strips provider prefixes", () => {
    const sonnet = modelRates(DEFAULT_RATE_CARD, "claude-cli", "sonnet");
    expect(sonnet).toEqual({
      rates: DEFAULT_RATE_CARD.models["claude-sonnet-5-5"],
      unpriced: false,
    });
    expect(modelRates(DEFAULT_RATE_CARD, "claude-cli", "anthropic/sonnet")).toEqual(sonnet);
    expect(modelRates(DEFAULT_RATE_CARD, "x", "claude-cli/claude-sonnet-5-5")).toEqual(sonnet);
    expect(modelRates(DEFAULT_RATE_CARD, "claude-cli", "haiku").unpriced).toBe(false);
    expect(modelRates(DEFAULT_RATE_CARD, "claude-cli", "default")).toEqual({
      rates: DEFAULT_RATE_CARD.fallback,
      unpriced: false,
    });
  });
  it("reads configured aliases over the defaults", () => {
    const custom = resolveRateCard({ aliases: { sonnet: "claude-sonnet-4-6", bad: 3 } });
    expect(modelRates(custom, "claude-cli", "sonnet").rates).toEqual(
      DEFAULT_RATE_CARD.models["claude-sonnet-4-6"],
    );
    expect(custom.aliases.bad).toBeUndefined();
    expect(custom.aliases.opus).toBe("claude-opus-5-5");
  });
});

describe("priceService", () => {
  it("prices known services and refuses unknown ones", () => {
    expect(priceService(card, "apify", 10)).toEqual({
      paise: 500,
      unitRatePaise: 50,
      unit: "compute-unit",
    });
    expect(priceService(card, "unknown", 1)).toBeUndefined();
  });
});

describe("resolveRateCard", () => {
  it("falls back to defaults for missing or invalid fields", () => {
    expect(resolveRateCard(undefined)).toEqual(DEFAULT_RATE_CARD);
    expect(resolveRateCard({ inrPerUsd: "x" }).inrPerUsd).toBe(DEFAULT_RATE_CARD.inrPerUsd);
    expect(Object.keys(DEFAULT_RATE_CARD.models)).toContain("claude-sonnet-5");
    expect(DEFAULT_RATE_CARD.services.hosting).toEqual({ unit: "day", inrPerUnit: 80 });
    expect(DEFAULT_RATE_CARD.models["claude-opus-5"].cacheReadUsdPerM).toBe(0.5);
  });
});

describe("formatInr", () => {
  it("formats paise as rupees with Indian grouping and a true minus sign", () => {
    expect(formatInr(124_050)).toBe("₹1,240.50");
    expect(formatInr(-31_200)).toBe("₹−312.00");
    expect(formatInr(12_345_678_900)).toBe("₹12,34,56,789.00");
  });
});
