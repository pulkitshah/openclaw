import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { WalletState, WalletStore } from "./store.js";

export type GateVerdict =
  | { allowed: true }
  | { allowed: false; balancePaise: number; creditLimitPaise: number };

// Structural subsets of the before_agent_run hook contract (not exported on the plugin SDK); the real types satisfy them.
type GateEvent = { senderId?: string };
type GateContext = { sessionKey?: string; attribution?: { kind: string } };
export type GateDecision = { outcome: "block"; reason: string; message?: string };

export function evaluateGate(state: WalletState, balancePaise: number): GateVerdict {
  if (state.enforce && balancePaise + state.creditLimitPaise <= 0) {
    return { allowed: false, balancePaise, creditLimitPaise: state.creditLimitPaise };
  }
  return { allowed: true };
}

/** What a blocked sender reads. Core appends "(blocked by wallet)" to the turn it refuses. */
export function exhaustedMessage(contact: string): string {
  return `Vasu is paused: the wallet balance is exhausted. Ask ${contact} to recharge, then send your message again.`;
}

/**
 * `before_agent_run`: refuses new turns while the wallet is exhausted. It only reads the verdict;
 * `stoppedSince` and the owner notice belong to `notices.reconcile()`. A bookkeeping failure never
 * blocks a turn (spec §5): any store error is logged and the turn is allowed.
 */
export function createBeforeAgentRun(deps: {
  store: WalletStore;
  contact: () => string;
  log: (message: string) => void;
}): (event: GateEvent, ctx: GateContext) => Promise<GateDecision | undefined> {
  /** Senders already told about the current stop; cleared as soon as the gate passes again. */
  const notified = new Set<string>();
  /** The `stoppedSince` the set was filled under; a different value is a new stop episode. */
  let episode: number | undefined;
  return async (event, ctx) => {
    // A Duty run already in flight keeps its own model calls: stopping it midway would strand it.
    if (ctx.attribution?.kind === "duty") {
      return undefined;
    }
    try {
      const state = await deps.store.getState();
      if (!state.enforce) {
        return undefined;
      }
      const verdict = evaluateGate(state, await deps.store.balance());
      if (verdict.allowed) {
        notified.clear();
        return undefined;
      }
      const stoppedSince = state.stoppedSince ?? 0;
      if (episode !== stoppedSince) {
        notified.clear();
        episode = stoppedSince;
      }
      const who = event.senderId ?? ctx.sessionKey ?? "";
      if (notified.has(who)) {
        return { outcome: "block", reason: "wallet_exhausted" };
      }
      notified.add(who);
      return {
        outcome: "block",
        reason: "wallet_exhausted",
        message: exhaustedMessage(deps.contact()),
      };
    } catch (error) {
      deps.log(`wallet: gate check failed, allowing the turn: ${coerceErrorMessage(error)}`);
      return undefined;
    }
  };
}
