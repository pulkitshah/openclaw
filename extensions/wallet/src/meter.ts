import { attribute, type AttributionLookups } from "./attribution.js";
import { markupTokens, priceTokens, type RateCard } from "./money.js";
import type { WalletStore } from "./store.js";

// The hook contract types are not on the plugin SDK, so these are the structural subsets of
// PluginHookLlmOutputEvent / PluginHookAgentContext the meter reads; the real types satisfy them.
type LlmOutputEvent = {
  runId?: string;
  provider: string;
  model: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
};
type MeterContext = {
  sessionKey?: string;
  agentId?: string;
  trigger?: string;
  jobId?: string;
  attribution?: { kind: string; ref: string; label: string };
};

export function createLlmOutputMeter(deps: {
  store: WalletStore;
  rateCard: () => RateCard;
  lookups: AttributionLookups;
  onUnrecorded: (error: unknown) => void;
  /** Runs after a successful append (balance notices); its failure is reported like a failed write. */
  afterAppend?: () => Promise<void>;
  /** Told the id of every debit written, for the throttled `changed` event. */
  onDebit?: (entryId: string) => void;
  /** Operator-facing diagnostics: the first event proves metering is live on a desk. */
  log?: (message: string) => void;
}): (event: LlmOutputEvent, ctx: MeterContext) => Promise<void> {
  let seen = 0;
  return async (event, ctx) => {
    seen += 1;
    if (seen === 1) {
      deps.log?.(
        `wallet: metering active (first llm_output: ${event.provider}/${event.model}, trigger=${ctx.trigger ?? "?"}, usage=${event.usage ? "present" : "missing"})`,
      );
    }
    try {
      const u = event.usage;
      if (!u) {
        deps.log?.(
          `wallet: llm_output without usage from ${event.provider}/${event.model}; nothing debited`,
        );
        return;
      }
      const card = deps.rateCard();
      const raw = {
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
      };
      if (raw.input + raw.output + raw.cacheRead + raw.cacheWrite <= 0) {
        return;
      }
      const tokens = markupTokens(card, raw);
      const price = priceTokens(card, event.provider, event.model, tokens);
      const a = await attribute(
        {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          trigger: ctx.trigger,
          attribution: ctx.attribution,
          jobId: ctx.jobId,
        },
        deps.lookups,
      );
      const entry = await deps.store.append({
        kind: "debit",
        charge: "tokens",
        activity: a.activity,
        ref: a.ref,
        label: a.label,
        provider: event.provider,
        model: event.model,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        rate: price.rate,
        unpriced: price.unpriced,
        amountPaise: -price.paise,
        source: "live",
        ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
      });
      deps.onDebit?.(entry.id);
      await deps.afterAppend?.();
    } catch (error) {
      deps.onUnrecorded(error);
    }
  };
}
