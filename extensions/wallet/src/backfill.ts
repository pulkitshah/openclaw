import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { attribute, type AttributionLookups } from "./attribution.js";
import { IST_OFFSET_MS, istDay } from "./hosting.js";
import { priceTokens, type RateCard } from "./money.js";
import type { BackfillResult, WalletStore } from "./store.js";

const SESSION_LIMIT = 1000;

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
type UsageSession = {
  key: string;
  agentId?: string;
  modelProvider?: string;
  model?: string;
  updatedAt?: number;
  usage?:
    | (Tokens & { lastActivity?: number; dailyBreakdown?: Array<Tokens & { date: string }> })
    | null;
};

const DAY_MS = 86_400_000;
/** 00:00 IST of an IST calendar day, as epoch ms. */
const dayStartIst = (day: string): number => Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS;
/** 12:00 IST of an IST calendar day, as epoch ms. */
const noonIst = (day: string): number => dayStartIst(day) + DAY_MS / 2;

export type BackfillOutcome = BackfillResult & { alreadyDone?: true };

/**
 * One-time import of recorded session usage as ledger debits, up to the moment the live meter
 * started on this desk (`meterStartedAt`). IST days before that day are imported in full; on the
 * cutover day only the tokens the live meter did not already record for that session are imported;
 * later days are never imported. Each (session, IST day) is marked only after its row is written; a
 * day that fails is logged, counted in `failed`, and left unmarked, and the run is not marked done,
 * so a rerun imports just that day. Once a run finishes with no failures, later calls return its
 * result with `alreadyDone` and touch nothing.
 */
export async function backfillFromUsage(deps: {
  store: WalletStore;
  rateCard: () => RateCard;
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  lookups: AttributionLookups;
  now?: () => number;
  log?: (message: string) => void;
}): Promise<BackfillOutcome> {
  const now = deps.now ?? Date.now;
  const state = await deps.store.getState();
  if (state.backfillDoneAt !== undefined) {
    return {
      ...(state.backfillResult ?? { sessions: 0, days: 0, failed: 0, paise: 0 }),
      alreadyDone: true,
    };
  }
  // The meter records its start when the service starts; a backfill can only run after that, so
  // the fallback only covers a store opened without the service (tests, tooling).
  const cutoverDay = istDay(state.meterStartedAt ?? (await deps.store.ensureMeterStarted(now())));
  // `mode: "specific"` makes sessions.usage split days in the given zone; without it days are UTC.
  const { sessions } = await deps.request<{ sessions: UsageSession[] }>("sessions.usage", {
    range: "all",
    agentScope: "all",
    limit: SESSION_LIMIT,
    mode: "specific",
    timeZone: "Asia/Kolkata",
    utcOffset: "UTC+5:30",
  });
  if (sessions.length === SESSION_LIMIT) {
    deps.log?.(
      `wallet: backfill read the ${SESSION_LIMIT}-session cap from sessions.usage; older sessions may be missing`,
    );
  }
  let contributing = 0;
  let days = 0;
  let failed = 0;
  let paise = 0;
  for (const session of sessions) {
    const usage = session.usage;
    if (!usage) {
      continue;
    }
    const breakdown = usage.dailyBreakdown?.length ? usage.dailyBreakdown : undefined;
    const sessionDays = breakdown ?? [
      { ...usage, date: istDay(usage.lastActivity ?? session.updatedAt ?? now()) },
    ];
    const provider = session.modelProvider ?? "claude-cli";
    const model = session.model ?? "unknown";
    let appended = 0;
    for (const day of sessionDays) {
      if (day.date > cutoverDay) {
        continue;
      }
      let tokens = {
        input: day.input,
        output: day.output,
        cacheRead: day.cacheRead,
        cacheWrite: day.cacheWrite,
      };
      if (day.date === cutoverDay) {
        const start = dayStartIst(day.date);
        const live = await deps.store.liveTokens(session.key, start, start + DAY_MS - 1);
        tokens = {
          input: Math.max(0, tokens.input - live.input),
          output: Math.max(0, tokens.output - live.output),
          cacheRead: Math.max(0, tokens.cacheRead - live.cacheRead),
          cacheWrite: Math.max(0, tokens.cacheWrite - live.cacheWrite),
        };
      }
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) {
        continue;
      }
      if (await deps.store.hasBackfill(session.key, day.date)) {
        continue;
      }
      const price = priceTokens(deps.rateCard(), provider, model, tokens);
      const { activity, ref, label } = await attribute(
        {
          sessionKey: session.key,
          agentId: session.agentId,
          trigger: session.key.endsWith(":main") ? "history" : undefined,
        },
        deps.lookups,
      );
      try {
        await deps.store.append({
          kind: "debit",
          charge: "tokens",
          activity,
          ref,
          label,
          provider,
          model,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          cacheReadTokens: tokens.cacheRead,
          cacheWriteTokens: tokens.cacheWrite,
          rate: price.rate,
          unpriced: price.unpriced,
          amountPaise: -price.paise,
          source: "backfill",
          sessionKey: session.key,
          ...(session.agentId ? { agentId: session.agentId } : {}),
          at: noonIst(day.date),
        });
        appended += 1;
        days += 1;
        paise += price.paise;
        await deps.store.markBackfill(session.key, day.date);
      } catch (error) {
        failed += 1;
        deps.log?.(
          `wallet: backfill failed for ${session.key} on ${day.date}: ${coerceErrorMessage(error)}`,
        );
      }
    }
    if (appended > 0) {
      contributing += 1;
    }
  }
  const result = { sessions: contributing, days, failed, paise };
  if (failed === 0) {
    await deps.store.setState({ backfillDoneAt: now(), backfillResult: result });
  }
  return result;
}
