import { attribute, type AttributionLookups } from "./attribution.js";
import { IST_OFFSET_MS, istDay } from "./hosting.js";
import { priceTokens, type RateCard } from "./money.js";
import type { WalletStore } from "./store.js";

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

/** 12:00 IST of an IST calendar day, as epoch ms. */
const noonIst = (day: string): number => Date.parse(`${day}T12:00:00Z`) - IST_OFFSET_MS;

/**
 * One-time import of recorded session usage as ledger debits. Each (session, IST day) is marked
 * only after its row is written, so a failed run can simply be run again.
 */
export async function backfillFromUsage(deps: {
  store: WalletStore;
  rateCard: () => RateCard;
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  lookups: AttributionLookups;
  now?: () => number;
  log?: (message: string) => void;
}): Promise<{ sessions: number; days: number; paise: number }> {
  const now = deps.now ?? Date.now;
  const { sessions } = await deps.request<{ sessions: UsageSession[] }>("sessions.usage", {
    range: "all",
    agentScope: "all",
    limit: SESSION_LIMIT,
    timeZone: "Asia/Kolkata",
  });
  if (sessions.length === SESSION_LIMIT) {
    deps.log?.(
      `wallet: backfill read the ${SESSION_LIMIT}-session cap from sessions.usage; older sessions may be missing`,
    );
  }
  let contributing = 0;
  let days = 0;
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
      const tokens = {
        input: day.input,
        output: day.output,
        cacheRead: day.cacheRead,
        cacheWrite: day.cacheWrite,
      };
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
      await deps.store.markBackfill(session.key, day.date);
      appended += 1;
      days += 1;
      paise += price.paise;
    }
    if (appended > 0) {
      contributing += 1;
    }
  }
  await deps.store.setState({ backfillDoneAt: now() });
  return { sessions: contributing, days, paise };
}
