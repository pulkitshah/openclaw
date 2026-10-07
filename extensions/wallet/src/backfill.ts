import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { AttributionLookups } from "./attribution.js";
import { IST_OFFSET_MS, dayName, istDay } from "./hosting.js";
import { priceTokens, type RateCard, type TokenCounts } from "./money.js";
import type { Activity, BackfillResult, NewEntry, WalletStore } from "./store.js";

type Totals = TokenCounts & { totalTokens: number };
type ModelUsage = { provider?: string; model?: string; totals: Totals };
type DayAgentUsage = {
  totals?: Totals;
  aggregates?: { byModel?: ModelUsage[]; byChannel?: Array<{ totals: Totals }> };
};
type OverviewUsage = {
  aggregates?: {
    daily?: Array<{ date: string; tokens: number }>;
    byAgent?: Array<{ agentId: string }>;
  };
};

const CLASSES = ["input", "output", "cacheRead", "cacheWrite"] as const;
const DAY_MS = 86_400_000;
// `mode: "specific"` makes sessions.usage split days in the given zone; without it days are UTC.
const IST_QUERY = { mode: "specific", timeZone: "Asia/Kolkata", utcOffset: "UTC+5:30" } as const;
/** 00:00 IST of an IST calendar day, as epoch ms. */
const dayStartIst = (day: string): number => Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS;
/** 12:00 IST of an IST calendar day, as epoch ms. */
const noonIst = (day: string): number => dayStartIst(day) + DAY_MS / 2;
const sumTokens = (t: TokenCounts): number => t.input + t.output + t.cacheRead + t.cacheWrite;
const mapTokens = (f: (c: (typeof CLASSES)[number]) => number): TokenCounts => ({
  input: f("input"),
  output: f("output"),
  cacheRead: f("cacheRead"),
  cacheWrite: f("cacheWrite"),
});

export type BackfillOutcome = BackfillResult & { alreadyDone?: true };

/**
 * One-time import of recorded usage as ledger debits, up to the moment the live meter started on
 * this desk (`meterStartedAt`). It reads `sessions.usage` aggregates, not its session list: the
 * list is capped, while a day's aggregates cover every session. One overview call finds the IST
 * days with usage and the agents; then each (day, agent) is read on its own and written as one row
 * per model, split into chat and system by the share of that agent-day that came through a channel
 * (mail agents book everything to mail). Days before the cutover day import in full; on the
 * cutover day only the tokens the live meter did not already record for that agent are imported;
 * later days are never imported. Each agent-day is marked only after its rows are written; one that
 * fails is logged, counted in `failed`, and left unmarked, and the run is not marked done, so a
 * rerun imports just that agent-day. Once a run finishes with no failures, later calls return its
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
      ...(state.backfillResult ?? { days: 0, agents: 0, failed: 0, paise: 0 }),
      alreadyDone: true,
    };
  }
  // The meter records its start when the service starts; a backfill can only run after that, so
  // the fallback only covers a store opened without the service (tests, tooling).
  const cutoverDay = istDay(state.meterStartedAt ?? (await deps.store.ensureMeterStarted(now())));
  // Aggregates cover every matched session regardless of `limit`; 1 keeps the payload small.
  const overview = await deps.request<OverviewUsage>("sessions.usage", {
    range: "all",
    agentScope: "all",
    limit: 1,
    ...IST_QUERY,
  });
  const days = (overview.aggregates?.daily ?? [])
    .filter((d) => d.tokens > 0 && d.date <= cutoverDay)
    .map((d) => d.date)
    .toSorted();
  const agents = (overview.aggregates?.byAgent ?? []).map((a) => a.agentId);
  const mailAgents = deps.lookups.mailAgentIds();
  const importedDays = new Set<string>();
  const importedAgents = new Set<string>();
  let failed = 0;
  let paise = 0;
  for (const day of days) {
    for (const agentId of agents) {
      const markKey = `agent:${agentId}`;
      if (await deps.store.hasBackfill(markKey, day)) {
        continue;
      }
      try {
        const usage = await deps.request<DayAgentUsage>("sessions.usage", {
          startDate: day,
          endDate: day,
          agentId,
          limit: 1,
          ...IST_QUERY,
        });
        const live =
          day === cutoverDay
            ? await deps.store.liveAgentTokens(
                agentId,
                dayStartIst(day),
                dayStartIst(day) + DAY_MS - 1,
              )
            : undefined;
        const rows = agentDayRows({
          day,
          agentId,
          usage,
          live,
          mail: mailAgents.includes(agentId),
          card: deps.rateCard(),
        });
        // Rows are built before any write, so a failed read or price writes nothing.
        for (const row of rows) {
          await deps.store.append(row);
          paise -= row.amountPaise;
        }
        await deps.store.markBackfill(markKey, day);
        if (rows.length > 0) {
          importedDays.add(day);
          importedAgents.add(agentId);
        }
      } catch (error) {
        failed += 1;
        deps.log?.(
          `wallet: backfill failed for agent ${agentId} on ${day}: ${coerceErrorMessage(error)}`,
        );
      }
    }
  }
  const result = { days: importedDays.size, agents: importedAgents.size, failed, paise };
  if (failed === 0) {
    await deps.store.setState({ backfillDoneAt: now(), backfillResult: result });
  }
  return result;
}

/** The ledger rows for one agent-day: one per model for a mail agent, else chat and system. */
function agentDayRows(input: {
  day: string;
  agentId: string;
  usage: DayAgentUsage;
  live: TokenCounts | undefined;
  mail: boolean;
  card: RateCard;
}): NewEntry[] {
  const { day, agentId, usage, live } = input;
  const models = (usage.aggregates?.byModel ?? []).filter((m) => m.totals.totalTokens > 0);
  const modelTotal = models.reduce((sum, m) => sum + m.totals.totalTokens, 0);
  const agentTotal = usage.totals?.totalTokens ?? 0;
  const channelTotal = (usage.aggregates?.byChannel ?? []).reduce(
    (sum, c) => sum + c.totals.totalTokens,
    0,
  );
  const chatShare = agentTotal > 0 ? Math.min(1, Math.max(0, channelTotal / agentTotal)) : 0;
  const label = dayName(day);
  const rows: NewEntry[] = [];
  for (const m of models) {
    // On the cutover day, the live meter's tokens for this agent are apportioned across its
    // models by their share of the day's tokens and subtracted per class.
    const weight = m.totals.totalTokens / modelTotal;
    const tokens = mapTokens((c) =>
      Math.max(0, m.totals[c] - (live ? Math.round(live[c] * weight) : 0)),
    );
    if (sumTokens(tokens) === 0) {
      continue;
    }
    const provider = m.provider ?? "claude-cli";
    const model = m.model ?? "unknown";
    const price = priceTokens(input.card, provider, model, tokens);
    const row = (
      activity: Activity,
      ref: string,
      rowLabel: string,
      share: TokenCounts,
      amount: number,
    ) => ({
      kind: "debit" as const,
      charge: "tokens" as const,
      activity,
      ref,
      label: `${rowLabel} — ${label} (history)`,
      provider,
      model,
      inputTokens: share.input,
      outputTokens: share.output,
      cacheReadTokens: share.cacheRead,
      cacheWriteTokens: share.cacheWrite,
      rate: price.rate,
      unpriced: price.unpriced,
      amountPaise: -amount,
      source: "backfill" as const,
      agentId,
      at: noonIst(day),
    });
    if (input.mail) {
      rows.push(row("mail", `backfill:${day}:${agentId}`, "Mail", tokens, price.paise));
      continue;
    }
    // The chat row takes the rounded channel share; system takes the remainder, so the pair sums
    // exactly to the model's tokens and price.
    const chat = mapTokens((c) => Math.round(tokens[c] * chatShare));
    const system = mapTokens((c) => tokens[c] - chat[c]);
    const chatPaise = Math.round(price.paise * chatShare);
    if (sumTokens(chat) > 0) {
      rows.push(row("chat", `backfill:${day}:${agentId}:chat`, "Chat", chat, chatPaise));
    }
    if (sumTokens(system) > 0) {
      rows.push(
        row(
          "system",
          `backfill:${day}:${agentId}:system`,
          "System",
          system,
          price.paise - chatPaise,
        ),
      );
    }
  }
  return rows;
}
