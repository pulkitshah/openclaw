import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

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
  services: Record<string, ServiceRate>;
};
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

// Anthropic list prices, USD per million tokens. Lookup from https://platform.claude.com/docs/pricing
// on 2026-10-07: Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5 input/output
// Cache rates: 20% of input for reads, 25% of output for writes
const OPUS: TokenRates = {
  inputUsdPerM: 5,
  outputUsdPerM: 25,
  cacheReadUsdPerM: 1,
  cacheWriteUsdPerM: 6.25,
};
const SONNET: TokenRates = {
  inputUsdPerM: 2,
  outputUsdPerM: 10,
  cacheReadUsdPerM: 0.4,
  cacheWriteUsdPerM: 2.5,
};
const HAIKU: TokenRates = {
  inputUsdPerM: 1,
  outputUsdPerM: 5,
  cacheReadUsdPerM: 0.2,
  cacheWriteUsdPerM: 1.25,
};

export const DEFAULT_RATE_CARD: RateCard = {
  inrPerUsd: 88,
  multiplier: 2,
  models: { "claude-opus-5": OPUS, "claude-sonnet-5": SONNET, "claude-haiku-4-5": HAIKU },
  fallback: OPUS,
  services: {
    hosting: { unit: "day", inrPerUnit: 80 },
    apify: { unit: "compute-unit", inrPerUnit: 0.5 },
  },
};

function readRates(raw: unknown): TokenRates | undefined {
  if (!isRecord(raw)) return undefined;
  const r = {
    inputUsdPerM: asFiniteNumber(raw.inputUsdPerM),
    outputUsdPerM: asFiniteNumber(raw.outputUsdPerM),
    cacheReadUsdPerM: asFiniteNumber(raw.cacheReadUsdPerM),
    cacheWriteUsdPerM: asFiniteNumber(raw.cacheWriteUsdPerM),
  };
  return Object.values(r).every((v) => v !== undefined && v >= 0) ? (r as TokenRates) : undefined;
}

export function resolveRateCard(raw: unknown): RateCard {
  const r = isRecord(raw) ? raw : {};
  const positive = (v: unknown, d: number) => {
    const n = asFiniteNumber(v);
    return n !== undefined && n > 0 ? n : d;
  };
  const models: Record<string, TokenRates> = { ...DEFAULT_RATE_CARD.models };
  if (isRecord(r.models))
    for (const [id, v] of Object.entries(r.models)) {
      const rates = readRates(v);
      if (rates) models[id] = rates;
    }
  const services: Record<string, ServiceRate> = { ...DEFAULT_RATE_CARD.services };
  if (isRecord(r.services))
    for (const [name, v] of Object.entries(r.services)) {
      if (!isRecord(v)) continue;
      const inrPerUnit = asFiniteNumber(v.inrPerUnit);
      const unit = typeof v.unit === "string" && v.unit.trim() ? v.unit.trim() : undefined;
      if (inrPerUnit !== undefined && inrPerUnit >= 0 && unit)
        services[name] = { unit, inrPerUnit };
    }
  return {
    inrPerUsd: positive(r.inrPerUsd, DEFAULT_RATE_CARD.inrPerUsd),
    multiplier: positive(r.multiplier, DEFAULT_RATE_CARD.multiplier),
    models,
    fallback: readRates(r.fallback) ?? DEFAULT_RATE_CARD.fallback,
    services,
  };
}

export function modelRates(
  card: RateCard,
  provider: string,
  model: string,
): { rates: TokenRates; unpriced: boolean } {
  const qualified = card.models[`${provider}/${model}`];
  if (qualified) return { rates: qualified, unpriced: false };
  const bare = card.models[model];
  if (bare) return { rates: bare, unpriced: false };
  return { rates: card.fallback, unpriced: true };
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
  if (!rate || !Number.isFinite(units) || units < 0) return undefined;
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
