import type { TokenCounts, TokenPrice } from "./money.js";

export type Activity = "chat" | "duty" | "mail" | "system" | "hosting" | "integration";
export type EntryBase = {
  /** The ledger's integer append order, as a string. */
  id: string;
  at: number;
  amountPaise: number;
  balanceAfterPaise: number;
  label: string;
  note?: string;
};
export type TokensDebit = EntryBase & {
  kind: "debit";
  charge: "tokens";
  activity: Activity;
  ref: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rate: TokenPrice["rate"];
  unpriced: boolean;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  source: "live" | "backfill";
};
export type ServiceDebit = EntryBase & {
  kind: "debit";
  charge: "service";
  activity: Activity;
  ref: string;
  service: string;
  units: number;
  unit: string;
  unitRatePaise: number;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  source: "live" | "backfill";
};
export type Credit = EntryBase & {
  kind: "credit";
  source: "manual" | "razorpay";
  reference: string;
  by: string;
};
export type Adjustment = EntryBase & { kind: "adjustment"; by: string };
export type WalletEntry = TokensDebit | ServiceDebit | Credit | Adjustment;
export type BackfillResult = { sessions: number; days: number; failed: number; paise: number };
export type WalletState = {
  creditLimitPaise: number;
  lowBalancePaise: number;
  enforce: boolean;
  lastLowNoticeAt?: number;
  lastStopNoticeAt?: number;
  stoppedSince?: number;
  hostingStartedOn?: string;
  backfillDoneAt?: number;
  /** When this desk first registered the live `llm_output` meter; the backfill cutover. */
  meterStartedAt?: number;
  backfillResult?: BackfillResult;
};
/** A key present with `null` or `undefined` clears that field; an absent key leaves it unchanged
 * (the worker transport keeps `undefined`-valued keys). */
export type StatePatch = { [K in keyof WalletState]?: WalletState[K] | null };
// Distributive so `kind` narrows the remaining fields (plain Omit over a union collapses it).
type OmitFrom<T, K extends keyof EntryBase> = T extends unknown ? Omit<T, K> : never;
export type NewEntry = OmitFrom<WalletEntry, "id" | "at" | "balanceAfterPaise"> & { at?: number };
export type ListFilter = {
  from?: number;
  to?: number;
  activity?: Activity;
  ref?: string;
  kind?: WalletEntry["kind"];
  limit?: number;
  /** Integer entry id: only rows appended before it. */
  before?: number;
};
export type Summary = {
  totalPaise: number;
  tokens: number;
  buckets: Array<{
    activity: Activity;
    paise: number;
    tokens: number;
    activities: Array<{
      ref: string;
      label: string;
      paise: number;
      tokens: number;
      entries: number;
    }>;
  }>;
};

export type WalletOperations = {
  getState: { input: undefined; output: WalletState };
  setState: { input: StatePatch; output: WalletState };
  ensureMeterStarted: { input: { at: number }; output: number };
  balance: { input: undefined; output: number };
  append: { input: NewEntry & { at: number }; output: WalletEntry };
  list: { input: ListFilter; output: WalletEntry[] };
  summarize: { input: { from: number; to: number }; output: Summary };
  spendSince: { input: { from: number }; output: { spentPaise: number; days: number } };
  liveTokens: {
    input: { sessionKey: string; from: number; to: number };
    output: TokenCounts;
  };
  markBackfill: { input: { sessionKey: string; day: string }; output: boolean };
  hasBackfill: { input: { sessionKey: string; day: string }; output: boolean };
  hasHosting: { input: { ref: string }; output: boolean };
  hostingRefsSince: { input: { from: number }; output: string[] };
};
