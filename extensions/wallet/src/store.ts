import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "../api.js";
import type { TokenPrice } from "./money.js";

export type Activity = "chat" | "duty" | "mail" | "system" | "hosting" | "integration";
export type EntryBase = {
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
export type WalletState = {
  creditLimitPaise: number;
  lowBalancePaise: number;
  enforce: boolean;
  lastLowNoticeAt?: number;
  lastStopNoticeAt?: number;
  stoppedSince?: number;
  hostingStartedOn?: string;
  backfillDoneAt?: number;
};
// Distributive so `kind` narrows the remaining fields (plain Omit over a union collapses it).
type OmitFrom<T, K extends keyof EntryBase> = T extends unknown ? Omit<T, K> : never;
export type NewEntry = OmitFrom<WalletEntry, "id" | "at" | "balanceAfterPaise"> & { at?: number };
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

type Keyed<T> = {
  register(k: string, v: T): Promise<void>;
  lookup(k: string): Promise<T | undefined>;
  entries(): Promise<Array<{ key: string; value: T }>>;
};
// The running balance rides in the state row so append reads one row instead of scanning the ledger.
type StoredState = WalletState & { balancePaise?: number };

const STATE_KEY = "state";
const BUCKET_ORDER: Activity[] = ["chat", "duty", "mail", "system", "hosting", "integration"];
export const DEFAULT_STATE: WalletState = {
  creditLimitPaise: 0,
  lowBalancePaise: 20_000,
  enforce: false,
};

function publicState({ balancePaise: _balance, ...state }: StoredState): WalletState {
  return state;
}

export class WalletStore {
  /** Appends are chained so two model calls finishing together cannot both read the same balance. */
  private chain: Promise<unknown> = Promise.resolve();
  private references?: Set<string>;
  private sequence = 0;
  constructor(
    private readonly stores: {
      entries: Keyed<WalletEntry>;
      state: Keyed<StoredState>;
      backfill: Keyed<{ at: number }>;
    },
  ) {}
  static open(api: OpenClawPluginApi): WalletStore {
    return new WalletStore({
      entries: api.runtime.state.openKeyedStore<WalletEntry>({
        namespace: "wallet-entries",
        maxEntries: 1_000_000,
        overflowPolicy: "reject-new",
      }),
      state: api.runtime.state.openKeyedStore<StoredState>({
        namespace: "wallet-state",
        maxEntries: 10,
        overflowPolicy: "reject-new",
      }),
      backfill: api.runtime.state.openKeyedStore<{ at: number }>({
        namespace: "wallet-backfill",
        maxEntries: 1_000_000,
        overflowPolicy: "reject-new",
      }),
    });
  }
  private async readState(): Promise<StoredState> {
    return { ...DEFAULT_STATE, ...(await this.stores.state.lookup(STATE_KEY)) };
  }
  async getState(): Promise<WalletState> {
    return publicState(await this.readState());
  }
  async setState(patch: Partial<WalletState>): Promise<WalletState> {
    return this.serialize(async () => {
      const next = { ...(await this.readState()), ...patch };
      await this.stores.state.register(STATE_KEY, next);
      return publicState(next);
    });
  }
  async balance(): Promise<number> {
    return (await this.readState()).balancePaise ?? 0;
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }
  async append(entry: NewEntry): Promise<WalletEntry> {
    return this.serialize(async () => {
      if (entry.kind === "credit") {
        this.references ??= new Set(
          (await this.stores.entries.entries()).flatMap(({ value }) =>
            value.kind === "credit" ? [value.reference] : [],
          ),
        );
        if (this.references.has(entry.reference)) {
          throw new Error(`duplicate reference: ${entry.reference}`);
        }
      }
      const state = await this.readState();
      const balanceAfterPaise = (state.balancePaise ?? 0) + entry.amountPaise;
      const at = entry.at ?? Date.now();
      // The id sorts in append order (wall clock, then per-process counter) so rows sharing an `at` list stably.
      const id = `${String(Date.now()).padStart(15, "0")}-${String(this.sequence++).padStart(8, "0")}-${randomUUID()}`;
      const row = { ...entry, id, at, balanceAfterPaise } as WalletEntry;
      await this.stores.entries.register(`${String(at).padStart(15, "0")}:${row.id}`, row);
      await this.stores.state.register(STATE_KEY, { ...state, balancePaise: balanceAfterPaise });
      if (row.kind === "credit") {
        this.references?.add(row.reference);
      }
      return row;
    });
  }
  async list(
    filter: {
      from?: number;
      to?: number;
      activity?: Activity;
      ref?: string;
      kind?: WalletEntry["kind"];
      limit?: number;
      before?: number;
    } = {},
  ): Promise<WalletEntry[]> {
    const rows = (await this.stores.entries.entries())
      .map((e) => e.value)
      .filter(
        (e) =>
          (filter.from === undefined || e.at >= filter.from) &&
          (filter.to === undefined || e.at <= filter.to) &&
          (filter.before === undefined || e.at < filter.before) &&
          (filter.kind === undefined || e.kind === filter.kind) &&
          (filter.activity === undefined || ("activity" in e && e.activity === filter.activity)) &&
          (filter.ref === undefined || ("ref" in e && e.ref === filter.ref)),
      )
      .toSorted((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    return filter.limit ? rows.slice(0, filter.limit) : rows;
  }
  async summarize(range: { from: number; to: number }): Promise<Summary> {
    const debits = (
      await this.list({ from: range.from, to: range.to, kind: "debit" })
    ).toReversed();
    const byActivity = new Map<
      Activity,
      Map<string, Summary["buckets"][number]["activities"][number]>
    >();
    let totalPaise = 0;
    for (const e of debits) {
      if (e.kind !== "debit") {
        continue;
      }
      const tokens =
        e.charge === "tokens"
          ? e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens
          : 0;
      const refs = byActivity.get(e.activity) ?? new Map();
      byActivity.set(e.activity, refs);
      const row = refs.get(e.ref) ?? {
        ref: e.ref,
        label: e.label,
        paise: 0,
        tokens: 0,
        entries: 0,
      };
      refs.set(e.ref, row);
      row.paise += e.amountPaise;
      row.tokens += tokens;
      row.entries += 1;
      totalPaise += e.amountPaise;
    }
    const buckets = BUCKET_ORDER.flatMap((activity) => {
      const refs = byActivity.get(activity);
      if (!refs) {
        return [];
      }
      const activities = [...refs.values()].toSorted((a, b) => a.paise - b.paise);
      return [
        {
          activity,
          paise: activities.reduce((sum, a) => sum + a.paise, 0),
          tokens: activities.reduce((sum, a) => sum + a.tokens, 0),
          activities,
        },
      ];
    });
    return { totalPaise, tokens: buckets.reduce((sum, b) => sum + b.tokens, 0), buckets };
  }
  async markBackfill(sessionKey: string, day: string): Promise<boolean> {
    const key = `${sessionKey}|${day}`;
    if (await this.stores.backfill.lookup(key)) {
      return false;
    }
    await this.stores.backfill.register(key, { at: Date.now() });
    return true;
  }
  async hasBackfill(sessionKey: string, day: string): Promise<boolean> {
    return Boolean(await this.stores.backfill.lookup(`${sessionKey}|${day}`));
  }
  async hasHosting(day: string): Promise<boolean> {
    return (await this.list({ activity: "hosting", ref: `hosting:${day}` })).length > 0;
  }
}
