import { asFiniteNumber, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { modelDisplayName, stripProviderPrefix } from "./model-names.js";

export type TokenRates = {
  inputUsdPerM: number;
  outputUsdPerM: number;
  cacheReadUsdPerM: number;
  cacheWriteUsdPerM: number;
};
export type ServiceRate = { unit: string; inrPerUnit: number };
export type RateCard = {
  inrPerUsd: number;
  multiplier: number;
  models: Record<string, TokenRates>;
  fallback: TokenRates;
  /** Short or runtime model names (`sonnet`, `default`) mapped to a `models` id. */
  aliases: Record<string, string>;
  services: Record<string, ServiceRate>;
};
export { modelDisplayName };
export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type TokenPrice = {
  paise: number;
  unpriced: boolean;
  rate: {
    inputInrPerM: number;
    outputInrPerM: number;
    cacheReadInrPerM: number;
    cacheWriteInrPerM: number;
  };
};

// USD per million tokens from the Claude API reference (pricing table cached 2026-09-25; cache read = 10% of input
// and cache write = 125% of input unless the reference states otherwise: Opus 5.5 / Sonnet 5.5 read $0.20,
// Fable 5.1 read $0.25). Re-check against https://platform.claude.com/docs/en/about-claude/pricing when repricing.
const OPUS: TokenRates = {
  inputUsdPerM: 5,
  outputUsdPerM: 25,
  cacheReadUsdPerM: 0.5,
  cacheWriteUsdPerM: 6.25,
};
const SONNET: TokenRates = {
  inputUsdPerM: 2,
  outputUsdPerM: 10,
  cacheReadUsdPerM: 0.2,
  cacheWriteUsdPerM: 2.5,
};
const HAIKU: TokenRates = {
  inputUsdPerM: 1,
  outputUsdPerM: 5,
  cacheReadUsdPerM: 0.1,
  cacheWriteUsdPerM: 1.25,
};
const OPUS_5_5: TokenRates = {
  inputUsdPerM: 4,
  outputUsdPerM: 20,
  cacheReadUsdPerM: 0.2,
  cacheWriteUsdPerM: 5,
};
const SONNET_5_5: TokenRates = {
  inputUsdPerM: 2,
  outputUsdPerM: 10,
  cacheReadUsdPerM: 0.2,
  cacheWriteUsdPerM: 2.5,
};
const OPUS_4_8: TokenRates = {
  inputUsdPerM: 5,
  outputUsdPerM: 25,
  cacheReadUsdPerM: 0.5,
  cacheWriteUsdPerM: 6.25,
};
const OPUS_4_7: TokenRates = {
  inputUsdPerM: 5,
  outputUsdPerM: 25,
  cacheReadUsdPerM: 0.5,
  cacheWriteUsdPerM: 6.25,
};
const OPUS_4_6: TokenRates = {
  inputUsdPerM: 5,
  outputUsdPerM: 25,
  cacheReadUsdPerM: 0.5,
  cacheWriteUsdPerM: 6.25,
};
const SONNET_4_6: TokenRates = {
  inputUsdPerM: 3,
  outputUsdPerM: 15,
  cacheReadUsdPerM: 0.3,
  cacheWriteUsdPerM: 3.75,
};
const FABLE_5_1: TokenRates = {
  inputUsdPerM: 10,
  outputUsdPerM: 50,
  cacheReadUsdPerM: 0.25,
  cacheWriteUsdPerM: 12.5,
};
const FABLE_5: TokenRates = {
  inputUsdPerM: 10,
  outputUsdPerM: 50,
  cacheReadUsdPerM: 1,
  cacheWriteUsdPerM: 12.5,
};

// Default pricing is the owner's policy: Anthropic list price at ₹100 per dollar plus a 30% premium.
export const DEFAULT_RATE_CARD: RateCard = {
  inrPerUsd: 100,
  multiplier: 1.3,
  models: {
    "claude-opus-5": OPUS,
    "claude-sonnet-5": SONNET,
    "claude-haiku-4-5": HAIKU,
    "claude-haiku-4-5-20251001": HAIKU,
    "claude-opus-5-5": OPUS_5_5,
    "claude-sonnet-5-5": SONNET_5_5,
    "claude-opus-4-8": OPUS_4_8,
    "claude-opus-4-7": OPUS_4_7,
    "claude-opus-4-6": OPUS_4_6,
    "claude-sonnet-4-6": SONNET_4_6,
    "claude-fable-5-1": FABLE_5_1,
    "claude-fable-5": FABLE_5,
    // Fetched 2026-10-07 from https://ai.google.dev/gemini-api/docs/pricing (paid tier, text; Gemini bills cache
    // writes at the input rate plus hourly storage, so the input rate is used; 3.1 Pro is the <=200k-token tier).
    "gemini-2.5-flash": {
      inputUsdPerM: 0.3,
      outputUsdPerM: 2.5,
      cacheReadUsdPerM: 0.03,
      cacheWriteUsdPerM: 0.3,
    },
    "gemini-2.5-flash-lite": {
      inputUsdPerM: 0.1,
      outputUsdPerM: 0.4,
      cacheReadUsdPerM: 0.01,
      cacheWriteUsdPerM: 0.1,
    },
    "gemini-3.1-pro-preview": {
      inputUsdPerM: 2,
      outputUsdPerM: 12,
      cacheReadUsdPerM: 0.2,
      cacheWriteUsdPerM: 2,
    },
    // Fetched 2026-10-07 from https://platform.openai.com/docs/models (OpenAI has no separate cache-write
    // price, so cache writes use the input rate).
    "gpt-5": {
      inputUsdPerM: 1.25,
      outputUsdPerM: 10,
      cacheReadUsdPerM: 0.125,
      cacheWriteUsdPerM: 1.25,
    },
    "gpt-5.2": {
      inputUsdPerM: 1.75,
      outputUsdPerM: 14,
      cacheReadUsdPerM: 0.175,
      cacheWriteUsdPerM: 1.75,
    },
    "gpt-5.4": {
      inputUsdPerM: 2.5,
      outputUsdPerM: 15,
      cacheReadUsdPerM: 0.25,
      cacheWriteUsdPerM: 2.5,
    },
    "gpt-5-mini": {
      inputUsdPerM: 0.25,
      outputUsdPerM: 2,
      cacheReadUsdPerM: 0.025,
      cacheWriteUsdPerM: 0.25,
    },
    "gpt-5-nano": {
      inputUsdPerM: 0.05,
      outputUsdPerM: 0.4,
      cacheReadUsdPerM: 0.005,
      cacheWriteUsdPerM: 0.05,
    },
  },
  fallback: OPUS,
  // claude-cli reports the alias the desk was configured with; `default` is the fallback's model.
  aliases: {
    opus: "claude-opus-5-5",
    sonnet: "claude-sonnet-5-5",
    haiku: "claude-haiku-4-5-20251001",
    default: "claude-opus-5",
  },
  services: {
    hosting: { unit: "day", inrPerUnit: 80 },
    apify: { unit: "compute-unit", inrPerUnit: 0.5 },
  },
};

function readRates(raw: unknown): TokenRates | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const inputUsdPerM = asFiniteNumber(raw.inputUsdPerM);
  const outputUsdPerM = asFiniteNumber(raw.outputUsdPerM);
  const cacheReadUsdPerM = asFiniteNumber(raw.cacheReadUsdPerM);
  const cacheWriteUsdPerM = asFiniteNumber(raw.cacheWriteUsdPerM);
  if (
    inputUsdPerM === undefined ||
    outputUsdPerM === undefined ||
    cacheReadUsdPerM === undefined ||
    cacheWriteUsdPerM === undefined ||
    Math.min(inputUsdPerM, outputUsdPerM, cacheReadUsdPerM, cacheWriteUsdPerM) < 0
  ) {
    return undefined;
  }
  return { inputUsdPerM, outputUsdPerM, cacheReadUsdPerM, cacheWriteUsdPerM };
}

export function resolveRateCard(raw: unknown): RateCard {
  const r = isRecord(raw) ? raw : {};
  const positive = (v: unknown, d: number) => {
    const n = asFiniteNumber(v);
    return n !== undefined && n > 0 ? n : d;
  };
  const models: Record<string, TokenRates> = { ...DEFAULT_RATE_CARD.models };
  if (isRecord(r.models)) {
    for (const [id, v] of Object.entries(r.models)) {
      const rates = readRates(v);
      if (rates) {
        models[id] = rates;
      }
    }
  }
  const services: Record<string, ServiceRate> = { ...DEFAULT_RATE_CARD.services };
  if (isRecord(r.services)) {
    for (const [name, v] of Object.entries(r.services)) {
      if (!isRecord(v)) {
        continue;
      }
      const inrPerUnit = asFiniteNumber(v.inrPerUnit);
      const unit = typeof v.unit === "string" && v.unit.trim() ? v.unit.trim() : undefined;
      if (inrPerUnit !== undefined && inrPerUnit >= 0 && unit) {
        services[name] = { unit, inrPerUnit };
      }
    }
  }
  const aliases: Record<string, string> = { ...DEFAULT_RATE_CARD.aliases };
  if (isRecord(r.aliases)) {
    for (const [alias, target] of Object.entries(r.aliases)) {
      if (typeof target === "string" && target.trim()) {
        aliases[alias] = target.trim();
      }
    }
  }
  return {
    inrPerUsd: positive(r.inrPerUsd, DEFAULT_RATE_CARD.inrPerUsd),
    multiplier: positive(r.multiplier, DEFAULT_RATE_CARD.multiplier),
    models,
    fallback: readRates(r.fallback) ?? DEFAULT_RATE_CARD.fallback,
    aliases,
    services,
  };
}

export function modelRates(
  card: RateCard,
  provider: string,
  model: string,
): { rates: TokenRates; unpriced: boolean } {
  const qualified = card.models[`${provider}/${model}`];
  if (qualified) {
    return { rates: qualified, unpriced: false };
  }
  // Provider-prefixed ids price by the same bare model id.
  const bare = stripProviderPrefix(model);
  const id = card.aliases[bare] ?? bare;
  const rates = card.models[id] ?? card.models[`${provider}/${id}`];
  return rates ? { rates, unpriced: false } : { rates: card.fallback, unpriced: true };
}

/** ₹ per million for one class: usd × inrPerUsd × multiplier. */
const inrPerM = (card: RateCard, usdPerM: number) => usdPerM * card.inrPerUsd * card.multiplier;

export function priceTokens(
  card: RateCard,
  provider: string,
  model: string,
  tokens: TokenCounts,
): TokenPrice {
  const { rates, unpriced } = modelRates(card, provider, model);
  const rate = {
    inputInrPerM: inrPerM(card, rates.inputUsdPerM),
    outputInrPerM: inrPerM(card, rates.outputUsdPerM),
    cacheReadInrPerM: inrPerM(card, rates.cacheReadUsdPerM),
    cacheWriteInrPerM: inrPerM(card, rates.cacheWriteUsdPerM),
  };
  const rupees =
    (tokens.input * rate.inputInrPerM +
      tokens.output * rate.outputInrPerM +
      tokens.cacheRead * rate.cacheReadInrPerM +
      tokens.cacheWrite * rate.cacheWriteInrPerM) /
    1_000_000;
  // One rounding per entry, half-up to the paisa; a floating error of 1e-9 must not flip a .5 down.
  return { paise: Math.round(rupees * 100 + 1e-9), unpriced, rate };
}

export function priceService(
  card: RateCard,
  service: string,
  units: number,
): { paise: number; unitRatePaise: number; unit: string } | undefined {
  const rate = card.services[service];
  if (!rate || !Number.isFinite(units) || units < 0) {
    return undefined;
  }
  const unitRatePaise = Math.round(rate.inrPerUnit * 100 + 1e-9);
  return {
    paise: Math.round(units * rate.inrPerUnit * 100 + 1e-9),
    unitRatePaise,
    unit: rate.unit,
  };
}

export function formatInr(paise: number): string {
  const sign = paise < 0 ? "−" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, "0");
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `₹${sign}${grouped}.${p}`;
}
