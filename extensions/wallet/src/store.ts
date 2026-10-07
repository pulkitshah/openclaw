import path from "node:path";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type {
  ListFilter,
  NewEntry,
  StatePatch,
  WalletEntry,
  WalletOperations,
  WalletState,
} from "./store-contract.js";

export type {
  Activity,
  Adjustment,
  BackfillResult,
  Credit,
  ListFilter,
  NewEntry,
  ServiceDebit,
  Summary,
  TokensDebit,
  WalletEntry,
  WalletState,
} from "./store-contract.js";

export const DEFAULT_STATE: WalletState = {
  creditLimitPaise: 0,
  lowBalancePaise: 20_000,
  enforce: false,
};

export type WalletStoreOptions = { workerModuleUrl: URL; stateDir?: string; dbPath?: string };

export function walletDatabasePath(options: { stateDir?: string; dbPath?: string }): string {
  return (
    options.dbPath ??
    path.join(options.stateDir ?? resolveStateDir(), "plugins", "wallet", "wallet.sqlite")
  );
}

/**
 * The wallet's own SQLite database (`<state-dir>/plugins/wallet/wallet.sqlite`), reached through a
 * SQLite worker. The worker opens on first use, so a model call metered before the plugin service
 * starts waits for the open instead of dropping its debit; `close()` lets a later use reopen it.
 */
export class WalletStore {
  private worker?: Promise<SqliteWorkerStore<WalletOperations>>;

  private constructor(private readonly options: () => WalletStoreOptions) {}

  /** Opens the database now (tests, and the service start). */
  static async open(options: WalletStoreOptions): Promise<WalletStore> {
    const store = new WalletStore(() => options);
    await store.ready();
    return store;
  }

  /** A store whose database opens on first use with the options current at that moment. */
  static deferred(options: () => WalletStoreOptions): WalletStore {
    return new WalletStore(options);
  }

  async ready(): Promise<void> {
    await this.connect();
  }

  private connect(): Promise<SqliteWorkerStore<WalletOperations>> {
    if (!this.worker) {
      const options = this.options();
      const opening = openSqliteWorkerStore<WalletOperations>({
        moduleUrl: options.workerModuleUrl,
        databasePath: walletDatabasePath(options),
        input: undefined,
      });
      this.worker = opening;
      // A failed open is not cached: the next call tries again.
      opening.catch(() => {
        if (this.worker === opening) {
          this.worker = undefined;
        }
      });
    }
    return this.worker;
  }

  private async execute<K extends keyof WalletOperations>(
    type: K,
    input: WalletOperations[K]["input"],
  ): Promise<WalletOperations[K]["output"]> {
    const worker = await this.connect();
    return worker.execute({ type, input });
  }

  getState(): Promise<WalletState> {
    return this.execute("getState", undefined);
  }

  /** A key present with `undefined` or `null` clears that field; absent keys are kept. */
  setState(patch: StatePatch): Promise<WalletState> {
    return this.execute("setState", patch);
  }

  /** Sets `meterStartedAt` the first time and returns the recorded value ever after. */
  ensureMeterStarted(at: number): Promise<number> {
    return this.execute("ensureMeterStarted", { at });
  }

  balance(): Promise<number> {
    return this.execute("balance", undefined);
  }

  append(entry: NewEntry): Promise<WalletEntry> {
    return this.execute("append", { ...entry, at: entry.at ?? Date.now() });
  }

  /** Newest appended first; `before` is an integer entry id. */
  list(filter: ListFilter = {}): Promise<WalletEntry[]> {
    return this.execute("list", filter);
  }

  summarize(range: { from: number; to: number }) {
    return this.execute("summarize", range);
  }

  spendSince(from: number) {
    return this.execute("spendSince", { from });
  }

  liveTokens(sessionKey: string, from: number, to: number) {
    return this.execute("liveTokens", { sessionKey, from, to });
  }

  markBackfill(sessionKey: string, day: string): Promise<boolean> {
    return this.execute("markBackfill", { sessionKey, day });
  }

  hasBackfill(sessionKey: string, day: string): Promise<boolean> {
    return this.execute("hasBackfill", { sessionKey, day });
  }

  hasHosting(day: string): Promise<boolean> {
    return this.execute("hasHosting", { ref: `hosting:${day}` });
  }

  hostingRefsSince(from: number): Promise<string[]> {
    return this.execute("hostingRefsSince", { from });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      await (await worker.catch(() => undefined))?.close();
    }
  }
}
