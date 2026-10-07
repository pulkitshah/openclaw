import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { priceService, type RateCard } from "./money.js";
import type { WalletStore } from "./store.js";

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** IST calendar day (YYYY-MM-DD) containing `ms`. */
export const istDay = (ms: number): string =>
  new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS;

const dayLabel = (day: string): string => {
  const [, month, date] = day.split("-").map(Number);
  return `Hosting — ${date} ${MONTHS[(month ?? 1) - 1]}`;
};

export type HostingDeps = {
  store: WalletStore;
  rateCard: () => RateCard;
  now: () => number;
  onChanged: () => void | Promise<void>;
  afterDebit?: () => Promise<void>;
  log?: (message: string) => void;
};

/** Posts one hosting debit per IST day from `hostingStartedOn` through today; returns rows posted. */
export async function postHostingDebits(deps: HostingDeps): Promise<number> {
  const price = priceService(deps.rateCard(), "hosting", 1);
  if (!price) {
    return 0;
  }
  const today = istDay(deps.now());
  let started = (await deps.store.getState()).hostingStartedOn;
  if (!started) {
    started = today;
    await deps.store.setState({ hostingStartedOn: started });
  }
  let posted = 0;
  for (let ms = dayStartMs(started); istDay(ms) <= today; ms += DAY_MS) {
    const day = istDay(ms);
    if (await deps.store.hasHosting(day)) {
      continue;
    }
    await deps.store.append({
      kind: "debit",
      charge: "service",
      activity: "hosting",
      ref: `hosting:${day}`,
      label: dayLabel(day),
      service: "hosting",
      units: 1,
      unit: price.unit,
      unitRatePaise: price.unitRatePaise,
      source: "live",
      amountPaise: -price.paise,
      at: ms,
    });
    posted += 1;
  }
  if (posted > 0) {
    await deps.onChanged();
    await deps.afterDebit?.();
  }
  return posted;
}

/** Runs the daily poster now and every `intervalMs`; errors are logged, never thrown. */
export function startHostingJob(
  deps: HostingDeps & { log: (message: string) => void },
  intervalMs = 15 * 60_000,
): () => void {
  const run = () =>
    postHostingDebits(deps).catch((error: unknown) => {
      deps.log(`wallet: hosting debit failed: ${coerceErrorMessage(error)}`);
    });
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
