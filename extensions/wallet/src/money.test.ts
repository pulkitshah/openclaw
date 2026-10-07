import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATE_CARD,
  formatInr,
  modelDisplayName,
  markupTokens,
  modelRates,
  priceService,
  priceTokens,
  resolveRateCard,
} from "./money.js";

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
  services: { apify: { unit: "compute-unit", inrPerUnit: 0.5 } },
});

describe("token markup", () => {
  it("defaults to list price with a 30% token markup", () => {
    expect(DEFAULT_RATE_CARD.multiplier).toBe(1);
    expect(DEFAULT_RATE_CARD.tokenMarkup).toBe(1.3);
    const resolved = resolveRateCard({});
    expect(resolved.multiplier).toBe(1);
    expect(resolved.tokenMarkup).toBe(1.3);
    expect(resolveRateCard({ tokenMarkup: 1.5 }).tokenMarkup).toBe(1.5);
    expect(resolveRateCard({ tokenMarkup: 0 }).tokenMarkup).toBe(1.3);
    expect(resolveRateCard({ tokenMarkup: -2 }).tokenMarkup).toBe(1.3);
  });
  it("scales each token class half-up and keeps zero at zero", () => {
    const marked = markupTokens(DEFAULT_RATE_CARD, {
      input: 7,
      output: 0,
      cacheRead: 1000,
      cacheWrite: 5,
    });
    // 7 × 1.3 = 9.1 → 9; 5 × 1.3 = 6.5 → 7 (half-up despite float error)
    expect(marked).toEqual({ input: 9, output: 0, cacheRead: 1300, cacheWrite: 7 });
  });
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

describe("non-Claude rate card entries", () => {
  const ids = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gpt-5",
    "gpt-5.2",
    "gpt-5.4",
    "gpt-5-mini",
    "gpt-5-nano",
  ];
  it.each(ids)("prices %s", (id) => {
    expect(modelRates(DEFAULT_RATE_CARD, "x", id).unpriced).toBe(false);
  });
  it("resolves provider-prefixed ids", () => {
    const flash = modelRates(DEFAULT_RATE_CARD, "google", "gemini-2.5-flash");
    expect(flash.rates.outputUsdPerM).toBe(2.5);
    expect(modelRates(DEFAULT_RATE_CARD, "google", "google/gemini-2.5-flash")).toEqual(flash);
    expect(modelRates(DEFAULT_RATE_CARD, "google", "gemini/gemini-2.5-flash")).toEqual(flash);
    expect(modelRates(DEFAULT_RATE_CARD, "openai", "openai/gpt-5.4").rates.inputUsdPerM).toBe(2.5);
  });
});

describe("modelDisplayName", () => {
  it("names known models and falls back to the raw id", () => {
    expect(modelDisplayName("claude-cli", "claude-opus-5")).toBe("Claude Opus 5");
    expect(modelDisplayName("claude-cli", "claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelDisplayName("claude-cli", "claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(modelDisplayName("claude-cli", "claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    expect(modelDisplayName("claude-cli", "claude-haiku-4-5-20251001")).toBe("Claude Haiku 4.5");
    expect(modelDisplayName("claude-cli", "claude-fable-5-1")).toBe("Claude Fable 5.1");
    expect(modelDisplayName("google", "google/gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(modelDisplayName("openai", "gpt-5.4")).toBe("GPT-5.4");
    expect(modelDisplayName("x", "mystery-1")).toBe("mystery-1");
  });
});

describe("a zero multiplier", () => {
  it("prices every token row at ₹0 while still recording the tokens; hosting is unaffected", () => {
    const card = resolveRateCard({ multiplier: 0 });
    expect(card.multiplier).toBe(0);
    const price = priceTokens(card, "claude-cli", "claude-opus-5", {
      input: 1_000,
      output: 100,
      cacheRead: 10_000,
      cacheWrite: 1_000,
    });
    expect(price.paise).toBe(0);
    expect(price.unpriced).toBe(false);
    expect(markupTokens(card, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }).input).toBe(
      13,
    );
    expect(priceService(card, "hosting", 1)?.paise).toBe(8_000);
    // A negative multiplier is rejected and falls back to the default.
    expect(resolveRateCard({ multiplier: -1 }).multiplier).toBe(DEFAULT_RATE_CARD.multiplier);
  });
});
