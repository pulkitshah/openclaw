import { attribute, type AttributionLookups } from "./attribution.js";
import { priceTokens, type RateCard } from "./money.js";
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
}): (event: LlmOutputEvent, ctx: MeterContext) => Promise<void> {
  return async (event, ctx) => {
    try {
      const u = event.usage;
      if (!u) {
        return;
      }
      const tokens = {
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
      };
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite <= 0) {
        return;
      }
      const price = priceTokens(deps.rateCard(), event.provider, event.model, tokens);
      const a = await attribute(
        {
          sessionKey: ctx.sessionKey,
          agentId: ctx.agentId,
          trigger: ctx.trigger,
          attribution: ctx.attribution,
          jobName: ctx.jobId,
        },
        deps.lookups,
      );
      await deps.store.append({
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
      await deps.afterAppend?.();
    } catch (error) {
      deps.onUnrecorded(error);
    }
  };
}
