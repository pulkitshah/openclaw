import { formatInr } from "./money.js";
import type { Credit, WalletStore } from "./store.js";

export type NoticeKind = "low" | "stopped" | "recharged";

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MIN_DAYS_OF_DATA = 3;

const istDay = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

export function createNotices(deps: {
  store: WalletStore;
  contact: () => string;
  send: (text: string) => Promise<void>;
  now?: () => number;
}): {
  afterDebit(): Promise<void>;
  afterCredit(credit: Credit): Promise<void>;
  afterSettings(): Promise<void>;
  afterStop(): Promise<void>;
} {
  const now = () => deps.now?.() ?? Date.now();

  /** Headroom over this week's average daily spend; undefined until three distinct days have debits. */
  const daysLeft = async (headroomPaise: number): Promise<number | undefined> => {
    const at = now();
    const debits = await deps.store.list({ from: at - 7 * DAY_MS, kind: "debit" });
    const days = new Set(debits.map((d) => istDay(d.at)));
    if (days.size < MIN_DAYS_OF_DATA) {
      return undefined;
    }
    const spent = debits.reduce((sum, d) => sum - d.amountPaise, 0);
    const perDay = spent / 7;
    return perDay > 0 ? Math.max(0, Math.floor(headroomPaise / perDay)) : undefined;
  };

  const sendStopped = async (): Promise<void> => {
    const state = await deps.store.getState();
    if (state.lastStopNoticeAt) {
      return;
    }
    // Recorded before the send so a failing channel cannot turn one stop into a stream of retries.
    await deps.store.setState({ lastStopNoticeAt: now() });
    await deps.send(
      `Vasu is paused — balance ${formatInr(await deps.store.balance())}, allowance ${formatInr(state.creditLimitPaise)} used up.`,
    );
  };

  return {
    async afterDebit() {
      const state = await deps.store.getState();
      const balance = await deps.store.balance();
      const headroom = balance + state.creditLimitPaise;
      if (state.enforce && headroom <= 0) {
        await sendStopped();
        return;
      }
      if (headroom >= state.lowBalancePaise || state.lastLowNoticeAt) {
        return;
      }
      await deps.store.setState({ lastLowNoticeAt: now() });
      const days = await daysLeft(headroom);
      const rate = days === undefined ? "" : ` — about ${days} days at this week's rate`;
      await deps.send(
        `Balance ${formatInr(balance)} — Vasu will pause when it runs out${rate}. Recharge: ${deps.contact()}.`,
      );
    },
    afterStop: sendStopped,
    async afterCredit(credit) {
      const state = await deps.store.getState();
      const balance = await deps.store.balance();
      const wasStopped = Boolean(state.stoppedSince || state.lastStopNoticeAt);
      const funded = balance + state.creditLimitPaise > 0;
      const back = wasStopped && funded ? " Vasu is back on." : "";
      await deps.send(
        `Recharged ${formatInr(credit.amountPaise)} (${credit.reference}). Balance ${formatInr(balance)}.${back}`,
      );
      if (funded) {
        // The low notice re-arms only once headroom is back above the line; a partial top-up must not repeat it.
        await deps.store.setState({
          ...(balance + state.creditLimitPaise >= state.lowBalancePaise
            ? { lastLowNoticeAt: undefined }
            : {}),
          lastStopNoticeAt: undefined,
          stoppedSince: undefined,
        });
      }
    },
    async afterSettings() {
      const state = await deps.store.getState();
      const balance = await deps.store.balance();
      if (state.stoppedSince && (!state.enforce || balance + state.creditLimitPaise > 0)) {
        await deps.store.setState({ stoppedSince: undefined, lastStopNoticeAt: undefined });
      }
    },
  };
}
