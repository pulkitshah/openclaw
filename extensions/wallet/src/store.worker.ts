import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  configureSqliteConnectionPragmas,
  migrateSqliteSchemaToStrict,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  enableNodeSqliteKyselyStatementCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
  type Generated,
  type SqliteWorkerCommand,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TokenCounts } from "./money.js";
import type {
  Activity,
  BackfillResult,
  ListFilter,
  NewEntry,
  StatePatch,
  Summary,
  WalletEntry,
  WalletOperations,
  WalletState,
} from "./store-contract.js";
import { WALLET_SCHEMA_SQL, WALLET_SCHEMA_VERSION } from "./store-schema.js";

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 19_800_000;
const BUCKET_ORDER: Activity[] = ["chat", "duty", "mail", "system", "hosting", "integration"];

type EntryRow = {
  id: Generated<number>;
  at: number;
  kind: WalletEntry["kind"];
  amount_paise: number;
  balance_after_paise: number;
  charge: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  rate_json: string | null;
  unpriced: number | null;
  service: string | null;
  units: number | null;
  unit: string | null;
  activity: string | null;
  ref: string | null;
  label: string;
  session_key: string | null;
  agent_id: string | null;
  run_id: string | null;
  source: string | null;
  reference: string | null;
  note: string | null;
  by: string | null;
};
type StateRow = {
  id: number;
  credit_limit_paise: number;
  low_balance_paise: number;
  enforce: number;
  last_low_notice_at: number | null;
  last_stop_notice_at: number | null;
  stopped_since: number | null;
  hosting_started_on: string | null;
  backfill_done_at: number | null;
  meter_started_at: number | null;
  backfill_result_json: string | null;
};
// The three settings columns carry schema defaults, so the bootstrap insert may omit them.
type StateTable = Omit<StateRow, "credit_limit_paise" | "low_balance_paise" | "enforce"> & {
  credit_limit_paise: Generated<number>;
  low_balance_paise: Generated<number>;
  enforce: Generated<number>;
};
type WalletDatabase = {
  wallet_schema_migrations: { id: string; applied_at: number };
  wallet_entries: EntryRow;
  wallet_state: StateTable;
  wallet_backfill_marks: { session_key: string; day: string; marked_at: number };
};
type SelectedEntry = Omit<EntryRow, "id"> & { id: number };

const ACTIVITIES: ReadonlySet<string> = new Set(BUCKET_ORDER);
const isActivity = (value: string | null): value is Activity =>
  value !== null && ACTIVITIES.has(value);
const num = (value: unknown): number => (typeof value === "number" ? value : 0);

function readBackfillResult(json: string | null): BackfillResult | undefined {
  if (json === null) {
    return undefined;
  }
  const value: unknown = JSON.parse(json);
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    sessions: num(value.sessions),
    days: num(value.days),
    failed: num(value.failed),
    paise: num(value.paise),
  };
}

function readState(row: StateRow): WalletState {
  const backfillResult = readBackfillResult(row.backfill_result_json);
  return {
    creditLimitPaise: row.credit_limit_paise,
    lowBalancePaise: row.low_balance_paise,
    enforce: row.enforce === 1,
    ...(row.last_low_notice_at !== null ? { lastLowNoticeAt: row.last_low_notice_at } : {}),
    ...(row.last_stop_notice_at !== null ? { lastStopNoticeAt: row.last_stop_notice_at } : {}),
    ...(row.stopped_since !== null ? { stoppedSince: row.stopped_since } : {}),
    ...(row.hosting_started_on !== null ? { hostingStartedOn: row.hosting_started_on } : {}),
    ...(row.backfill_done_at !== null ? { backfillDoneAt: row.backfill_done_at } : {}),
    ...(row.meter_started_at !== null ? { meterStartedAt: row.meter_started_at } : {}),
    ...(backfillResult ? { backfillResult } : {}),
  };
}

function stateColumns(patch: StatePatch): Partial<Omit<StateRow, "id">> {
  const columns: Partial<Omit<StateRow, "id">> = {};
  const set = <K extends keyof Omit<StateRow, "id">>(key: K, value: StateRow[K] | undefined) => {
    if (value !== undefined) {
      columns[key] = value;
    }
  };
  // A key that is present with `null` or `undefined` clears a nullable column; an absent key is
  // left alone. The three required columns ignore a clear.
  const pick = <K extends keyof StatePatch>(key: K) =>
    key in patch ? (patch[key] ?? null) : undefined;
  set("credit_limit_paise", pick("creditLimitPaise") ?? undefined);
  set("low_balance_paise", pick("lowBalancePaise") ?? undefined);
  const enforce = pick("enforce");
  set("enforce", enforce === undefined || enforce === null ? undefined : enforce ? 1 : 0);
  set("last_low_notice_at", pick("lastLowNoticeAt"));
  set("last_stop_notice_at", pick("lastStopNoticeAt"));
  set("stopped_since", pick("stoppedSince"));
  set("hosting_started_on", pick("hostingStartedOn"));
  set("backfill_done_at", pick("backfillDoneAt"));
  set("meter_started_at", pick("meterStartedAt"));
  const backfillResult = pick("backfillResult");
  set(
    "backfill_result_json",
    backfillResult === undefined
      ? undefined
      : backfillResult === null
        ? null
        : JSON.stringify(backfillResult),
  );
  return columns;
}

function entryRow(entry: NewEntry & { at: number }, balanceAfterPaise: number) {
  const base = {
    at: entry.at,
    kind: entry.kind,
    amount_paise: entry.amountPaise,
    balance_after_paise: balanceAfterPaise,
    label: entry.label,
    note: entry.note ?? null,
    charge: null,
    provider: null,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    rate_json: null,
    unpriced: null,
    service: null,
    units: null,
    unit: null,
    activity: null,
    ref: null,
    session_key: null,
    agent_id: null,
    run_id: null,
    source: null,
    reference: null,
    by: null,
  };
  switch (entry.kind) {
    case "credit":
      return { ...base, source: entry.source, reference: entry.reference, by: entry.by };
    case "adjustment":
      return { ...base, by: entry.by };
    case "debit": {
      const debit = {
        ...base,
        charge: entry.charge,
        activity: entry.activity,
        ref: entry.ref,
        source: entry.source,
        session_key: entry.sessionKey ?? null,
        agent_id: entry.agentId ?? null,
        run_id: entry.runId ?? null,
      };
      return entry.charge === "tokens"
        ? {
            ...debit,
            provider: entry.provider,
            model: entry.model,
            input_tokens: entry.inputTokens,
            output_tokens: entry.outputTokens,
            cache_read_tokens: entry.cacheReadTokens,
            cache_write_tokens: entry.cacheWriteTokens,
            rate_json: JSON.stringify(entry.rate),
            unpriced: entry.unpriced ? 1 : 0,
          }
        : {
            ...debit,
            service: entry.service,
            units: entry.units,
            unit: entry.unit,
            rate_json: JSON.stringify({ unit: entry.unit, unit_rate_paise: entry.unitRatePaise }),
          };
    }
  }
}

function readTokenRate(json: string | null) {
  const value: unknown = json === null ? undefined : JSON.parse(json);
  const rate = isRecord(value) ? value : {};
  return {
    inputInrPerM: num(rate.inputInrPerM),
    outputInrPerM: num(rate.outputInrPerM),
    cacheReadInrPerM: num(rate.cacheReadInrPerM),
    cacheWriteInrPerM: num(rate.cacheWriteInrPerM),
  };
}

function readEntry(row: SelectedEntry): WalletEntry {
  const base = {
    id: String(row.id),
    at: row.at,
    amountPaise: row.amount_paise,
    balanceAfterPaise: row.balance_after_paise,
    label: row.label,
    ...(row.note !== null ? { note: row.note } : {}),
  };
  if (row.kind === "credit") {
    return {
      ...base,
      kind: "credit",
      source: row.source === "razorpay" ? "razorpay" : "manual",
      reference: row.reference ?? "",
      by: row.by ?? "",
    };
  }
  if (row.kind === "adjustment") {
    return { ...base, kind: "adjustment", by: row.by ?? "" };
  }
  const debit = {
    ...base,
    kind: "debit" as const,
    activity: isActivity(row.activity) ? row.activity : "chat",
    ref: row.ref ?? "",
    source: row.source === "backfill" ? ("backfill" as const) : ("live" as const),
    ...(row.session_key !== null ? { sessionKey: row.session_key } : {}),
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
  };
  if (row.charge === "service") {
    const rate: unknown = row.rate_json === null ? undefined : JSON.parse(row.rate_json);
    return {
      ...debit,
      charge: "service",
      service: row.service ?? "",
      units: row.units ?? 0,
      unit: row.unit ?? "",
      unitRatePaise: isRecord(rate) ? num(rate.unit_rate_paise) : 0,
    };
  }
  return {
    ...debit,
    charge: "tokens",
    provider: row.provider ?? "",
    model: row.model ?? "",
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheWriteTokens: row.cache_write_tokens ?? 0,
    rate: readTokenRate(row.rate_json),
    unpriced: row.unpriced === 1,
  };
}

function isUniqueViolation(error: unknown, index: string): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/.test(error.message) &&
    error.message.includes(index)
  );
}

function chmodIfExists(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

class WalletSqlite {
  private readonly query;

  constructor(
    private readonly db: DatabaseSync,
    private readonly maintenance: ReturnType<typeof configureSqliteConnectionPragmas>,
  ) {
    this.query = getNodeSqliteKysely<WalletDatabase>(db);
  }

  private readStateRow(): StateRow {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query.selectFrom("wallet_state").selectAll().where("id", "=", 1),
    );
    if (!row) {
      throw new Error("wallet state row is missing");
    }
    return row;
  }

  getState(): WalletState {
    return readState(this.readStateRow());
  }

  setState(patch: StatePatch): WalletState {
    const columns = stateColumns(patch);
    return runSqliteImmediateTransactionSync(this.db, () => {
      if (Object.keys(columns).length > 0) {
        executeSqliteQuerySync(
          this.db,
          this.query.updateTable("wallet_state").set(columns).where("id", "=", 1),
        );
      }
      return readState(this.readStateRow());
    });
  }

  /** Records the first registration of the live meter; later calls keep the original instant. */
  ensureMeterStarted(at: number): number {
    return runSqliteImmediateTransactionSync(this.db, () => {
      executeSqliteQuerySync(
        this.db,
        this.query
          .updateTable("wallet_state")
          .set({ meter_started_at: at })
          .where("id", "=", 1)
          .where("meter_started_at", "is", null),
      );
      return this.readStateRow().meter_started_at ?? at;
    });
  }

  balance(): number {
    const last = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("wallet_entries")
        .select("balance_after_paise")
        .orderBy("id", "desc")
        .limit(1),
    );
    return last?.balance_after_paise ?? 0;
  }

  append(entry: NewEntry & { at: number }): WalletEntry {
    try {
      // Reading the last balance and inserting share one immediate transaction, so concurrent
      // appends (from any connection) always chain from the row before them.
      return runSqliteImmediateTransactionSync(this.db, () => {
        const row = entryRow(entry, this.balance() + entry.amountPaise);
        const inserted = executeSqliteQueryTakeFirstSync(
          this.db,
          this.query.insertInto("wallet_entries").values(row).returningAll(),
        );
        if (!inserted) {
          throw new Error("wallet entry insert returned no row");
        }
        return readEntry(inserted);
      });
    } catch (error) {
      if (entry.kind === "credit" && isUniqueViolation(error, "wallet_entries.reference")) {
        throw new Error(`duplicate reference: ${entry.reference}`, { cause: error });
      }
      if (
        entry.kind === "debit" &&
        entry.activity === "hosting" &&
        isUniqueViolation(error, "wallet_entries.ref")
      ) {
        throw new Error(`hosting already posted: ${entry.ref}`, { cause: error });
      }
      throw error;
    }
  }

  list(filter: ListFilter): WalletEntry[] {
    let query = this.query.selectFrom("wallet_entries").selectAll();
    if (filter.from !== undefined) {
      query = query.where("at", ">=", filter.from);
    }
    if (filter.to !== undefined) {
      query = query.where("at", "<=", filter.to);
    }
    if (filter.before !== undefined) {
      query = query.where("id", "<", filter.before);
    }
    if (filter.kind !== undefined) {
      query = query.where("kind", "=", filter.kind);
    }
    if (filter.activity !== undefined) {
      query = query.where("activity", "=", filter.activity);
    }
    if (filter.ref !== undefined) {
      query = query.where("ref", "=", filter.ref);
    }
    query = query.orderBy("id", "desc");
    if (filter.limit !== undefined) {
      query = query.limit(filter.limit);
    }
    return executeSqliteQuerySync(this.db, query).rows.map(readEntry);
  }

  summarize(range: { from: number; to: number }): Summary {
    const rows = executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("wallet_entries")
        .select((eb) => [
          "activity",
          "ref",
          // With max(id) in the same select, SQLite takes this bare column from the newest row of
          // the group, so a ref whose label changed (a member renamed) reads as its latest label.
          "label",
          eb.fn.max("id").as("lastId"),
          eb.fn.sum<number>("amount_paise").as("paise"),
          eb.fn
            .sum<number>(
              eb(
                eb(
                  eb(
                    eb.fn.coalesce("input_tokens", eb.lit(0)),
                    "+",
                    eb.fn.coalesce("output_tokens", eb.lit(0)),
                  ),
                  "+",
                  eb.fn.coalesce("cache_read_tokens", eb.lit(0)),
                ),
                "+",
                eb.fn.coalesce("cache_write_tokens", eb.lit(0)),
              ),
            )
            .as("tokens"),
          eb.fn.countAll<number>().as("entries"),
        ])
        .where("kind", "=", "debit")
        .where("at", ">=", range.from)
        .where("at", "<=", range.to)
        .groupBy(["activity", "ref"]),
    ).rows;
    const byActivity = new Map<Activity, Summary["buckets"][number]["activities"]>();
    let totalPaise = 0;
    for (const row of rows) {
      if (!isActivity(row.activity)) {
        continue;
      }
      const list = byActivity.get(row.activity) ?? [];
      byActivity.set(row.activity, list);
      list.push({
        ref: row.ref ?? "",
        label: row.label,
        paise: num(row.paise),
        tokens: num(row.tokens),
        entries: num(row.entries),
      });
      totalPaise += num(row.paise);
    }
    const buckets = BUCKET_ORDER.flatMap((activity) => {
      const activities = byActivity.get(activity);
      if (!activities) {
        return [];
      }
      // Debits are negative, so ascending puts the biggest spend first.
      activities.sort((a, b) => a.paise - b.paise);
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

  spendSince(from: number): { spentPaise: number; days: number } {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("wallet_entries")
        .select((eb) => [
          eb.fn.sum<number>("amount_paise").as("paise"),
          // Distinct IST calendar days: shift to IST, then integer-divide into whole days.
          eb.fn
            .count<number>(
              eb(eb.parens(eb(eb.ref("at"), "+", eb.lit(IST_OFFSET_MS))), "/", eb.lit(DAY_MS)),
            )
            .distinct()
            .as("days"),
        ])
        .where("kind", "=", "debit")
        .where("at", ">=", from),
    );
    return { spentPaise: -num(row?.paise), days: num(row?.days) };
  }

  liveTokens(sessionKey: string, from: number, to: number): TokenCounts {
    const row = executeSqliteQueryTakeFirstSync(
      this.db,
      this.query
        .selectFrom("wallet_entries")
        .select((eb) => [
          eb.fn.sum<number>("input_tokens").as("input"),
          eb.fn.sum<number>("output_tokens").as("output"),
          eb.fn.sum<number>("cache_read_tokens").as("cacheRead"),
          eb.fn.sum<number>("cache_write_tokens").as("cacheWrite"),
        ])
        .where("session_key", "=", sessionKey)
        .where("source", "=", "live")
        .where("charge", "=", "tokens")
        .where("at", ">=", from)
        .where("at", "<=", to),
    );
    return {
      input: num(row?.input),
      output: num(row?.output),
      cacheRead: num(row?.cacheRead),
      cacheWrite: num(row?.cacheWrite),
    };
  }

  markBackfill(sessionKey: string, day: string): boolean {
    const result = executeSqliteQuerySync(
      this.db,
      this.query
        .insertInto("wallet_backfill_marks")
        .values({ session_key: sessionKey, day, marked_at: Date.now() })
        .onConflict((conflict) => conflict.columns(["session_key", "day"]).doNothing()),
    );
    return result.numAffectedRows === 1n;
  }

  hasBackfill(sessionKey: string, day: string): boolean {
    return Boolean(
      executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("wallet_backfill_marks")
          .select("day")
          .where("session_key", "=", sessionKey)
          .where("day", "=", day),
      ),
    );
  }

  hasHosting(ref: string): boolean {
    return Boolean(
      executeSqliteQueryTakeFirstSync(
        this.db,
        this.query
          .selectFrom("wallet_entries")
          .select("id")
          .where("activity", "=", "hosting")
          .where("ref", "=", ref),
      ),
    );
  }

  hostingRefsSince(from: number): string[] {
    return executeSqliteQuerySync(
      this.db,
      this.query
        .selectFrom("wallet_entries")
        .select("ref")
        .where("activity", "=", "hosting")
        .where("at", ">=", from),
    ).rows.flatMap((row) => (row.ref === null ? [] : [row.ref]));
  }

  close(): void {
    try {
      this.maintenance.close();
    } finally {
      this.db.close();
    }
  }
}

function openWalletDatabase(dbPath: string): WalletSqlite {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(dbPath), 0o700);
  if (!fs.existsSync(dbPath)) {
    fs.closeSync(fs.openSync(dbPath, "a", 0o600));
  }
  const db = openNodeSqliteDatabase(dbPath);
  let maintenance: ReturnType<typeof configureSqliteConnectionPragmas> | undefined;
  try {
    enableNodeSqliteKyselyStatementCache(db);
    maintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 5000,
      checkpointIntervalMs: 0,
      databaseLabel: "wallet database",
      databasePath: dbPath,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    db.exec(WALLET_SCHEMA_SQL);
    const query = getNodeSqliteKysely<WalletDatabase>(db);
    const migration = executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("wallet_schema_migrations")
        .select("id")
        .where("id", "=", WALLET_SCHEMA_VERSION),
    );
    if (!migration) {
      migrateSqliteSchemaToStrict(db, WALLET_SCHEMA_SQL, { databaseLabel: "wallet database" });
      executeSqliteQuerySync(
        db,
        query
          .insertInto("wallet_schema_migrations")
          .values({ id: WALLET_SCHEMA_VERSION, applied_at: Date.now() })
          .onConflict((conflict) => conflict.column("id").doNothing()),
      );
    }
    // The single state row exists from the first open; every read and update targets id 1.
    executeSqliteQuerySync(
      db,
      query
        .insertInto("wallet_state")
        .values({ id: 1 })
        .onConflict((conflict) => conflict.column("id").doNothing()),
    );
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      chmodIfExists(file);
    }
    return new WalletSqlite(db, maintenance);
  } catch (error) {
    try {
      maintenance?.close();
    } finally {
      db.close();
    }
    throw error;
  }
}

export function createSqliteWorkerBackend(_input: undefined, context: { databasePath: string }) {
  const database = openWalletDatabase(context.databasePath);
  return {
    execute(command: SqliteWorkerCommand<WalletOperations>) {
      switch (command.type) {
        case "getState":
          return database.getState();
        case "setState":
          return database.setState(command.input);
        case "ensureMeterStarted":
          return database.ensureMeterStarted(command.input.at);
        case "balance":
          return database.balance();
        case "append":
          return database.append(command.input);
        case "list":
          return database.list(command.input);
        case "summarize":
          return database.summarize(command.input);
        case "spendSince":
          return database.spendSince(command.input.from);
        case "liveTokens":
          return database.liveTokens(
            command.input.sessionKey,
            command.input.from,
            command.input.to,
          );
        case "markBackfill":
          return database.markBackfill(command.input.sessionKey, command.input.day);
        case "hasBackfill":
          return database.hasBackfill(command.input.sessionKey, command.input.day);
        case "hasHosting":
          return database.hasHosting(command.input.ref);
        case "hostingRefsSince":
          return database.hostingRefsSince(command.input.from);
      }
    },
    close: () => database.close(),
  };
}
