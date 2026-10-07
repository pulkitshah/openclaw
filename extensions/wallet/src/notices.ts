import { evaluateGate } from "./gate.js";
import { formatInr } from "./money.js";
import type { StatePatch } from "./store-contract.js";
import type { Credit, WalletStore } from "./store.js";

export type NoticeKind = "low" | "stopped" | "recharged";

const DAY_MS = 86_400_000;
const MIN_DAYS_OF_DATA = 3;

/** Headroom over this week's average daily spend; undefined until three distinct IST days have debits. */
export async function daysLeft(
  store: WalletStore,
  headroomPaise: number,
  at: number,
): Promise<number | undefined> {
  const { spentPaise, days } = await store.spendSince(at - 7 * DAY_MS);
  if (days < MIN_DAYS_OF_DATA) {
    return undefined;
  }
  const perDay = spentPaise / 7;
  return perDay > 0 ? Math.max(0, Math.floor(headroomPaise / perDay)) : undefined;
}

/**
 * The one owner of the paused/low state. Every write path (meter, hosting, charges, credits,
 * adjustments, settings, backfill) calls `reconcile()` after its write; the gate only reads the
 * verdict. Low and stopped owner notices go out only while `enforce` is on; the Recharged notice
 * goes out on every credit.
 */
export function createNotices(deps: {
  store: WalletStore;
  contact: () => string;
  send: (text: string) => Promise<void>;
  now?: () => number;
}): {
  reconcile(): Promise<void>;
  afterCredit(credit: Credit): Promise<void>;
} {
  const now = () => deps.now?.() ?? Date.now();

  const reconcile = async (): Promise<void> => {
    const state = await deps.store.getState();
    const balance = await deps.store.balance();
    const headroom = balance + state.creditLimitPaise;
    const verdict = evaluateGate(state, balance);
    if (!verdict.allowed) {
      if (state.stoppedSince !== undefined && state.lastStopNoticeAt !== undefined) {
        return;
      }
      // Recorded before the send so a failing channel cannot turn one stop into a stream of retries.
      const at = now();
      await deps.store.setState({
        stoppedSince: state.stoppedSince ?? at,
        lastStopNoticeAt: state.lastStopNoticeAt ?? at,
      });
      if (state.lastStopNoticeAt === undefined) {
        await deps.send(
          `Vasu is paused — balance ${formatInr(balance)}, allowance ${formatInr(state.creditLimitPaise)} used up.`,
        );
      }
      return;
    }
    const patch: StatePatch = {};
    if (state.stoppedSince !== undefined || state.lastStopNoticeAt !== undefined) {
      patch.stoppedSince = null;
      patch.lastStopNoticeAt = null;
    }
    let low: string | undefined;
    if (headroom >= state.lowBalancePaise) {
      // Re-armed only once headroom is back at or above the line; a partial top-up keeps it sent.
      if (state.lastLowNoticeAt !== undefined) {
        patch.lastLowNoticeAt = null;
      }
    } else if (state.enforce && state.lastLowNoticeAt === undefined) {
      patch.lastLowNoticeAt = now();
      const days = await daysLeft(deps.store, headroom, now());
      const rate = days === undefined ? "" : ` — about ${days} days at this week's rate`;
      low = `Balance ${formatInr(balance)} — Vasu will pause when it runs out${rate}. Recharge: ${deps.contact()}.`;
    }
    if (Object.keys(patch).length > 0) {
      await deps.store.setState(patch);
    }
    if (low) {
      await deps.send(low);
    }
  };

  return {
    reconcile,
    async afterCredit(credit) {
      const state = await deps.store.getState();
      const balance = await deps.store.balance();
      const wasStopped = state.stoppedSince !== undefined || state.lastStopNoticeAt !== undefined;
      const back = wasStopped && evaluateGate(state, balance).allowed ? " Vasu is back on." : "";
      try {
        await deps.send(
          `Recharged ${formatInr(credit.amountPaise)} (${credit.reference}). Balance ${formatInr(balance)}.${back}`,
        );
      } finally {
        await reconcile();
      }
    },
  };
}
