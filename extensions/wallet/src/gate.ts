import { formatInr } from "./money.js";
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

export function exhaustedMessage(
  v: Extract<GateVerdict, { allowed: false }>,
  contact: string,
): string {
  return `Balance exhausted (${formatInr(v.balancePaise)} of ${formatInr(v.creditLimitPaise)} allowed). Ask ${contact} to recharge — your message is kept and will be answered after recharge.`;
}

export function createBeforeAgentRun(deps: {
  store: WalletStore;
  contact: () => string;
  onStopped: () => Promise<void>;
}): (event: GateEvent, ctx: GateContext) => Promise<GateDecision | undefined> {
  /** Senders already told about the current stop; cleared as soon as the gate passes again. */
  const notified = new Set<string>();
  /** The `stoppedSince` the set was filled under; a different value is a new stop episode. */
  let episode: number | undefined;
  return async (event, ctx) => {
    const attribution = ctx.attribution;
    // A Duty run already in flight keeps its own model calls: stopping it midway would strand it.
    if (attribution?.kind === "duty") {
      return undefined;
    }
    const state = await deps.store.getState();
    const verdict = evaluateGate(state, await deps.store.balance());
    if (verdict.allowed) {
      notified.clear();
      return undefined;
    }
    let stoppedSince = state.stoppedSince;
    if (!stoppedSince) {
      stoppedSince = Date.now();
      await deps.store.setState({ stoppedSince });
      try {
        await deps.onStopped();
      } catch {
        // The notice is best effort; the block itself must still hold.
      }
    }
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
      message: exhaustedMessage(verdict, deps.contact()),
    };
  };
}
