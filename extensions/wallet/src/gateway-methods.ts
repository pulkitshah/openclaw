import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../api.js";
import type { AttributionLookups } from "./attribution.js";
import { backfillFromUsage } from "./backfill.js";
import { evaluateGate, exhaustedMessage } from "./gate.js";
import type { Ctx, Scope } from "./gateway-context.js";
import { IST_OFFSET_MS } from "./hosting.js";
import { priceService, type RateCard } from "./money.js";
import { daysLeft, type createNotices } from "./notices.js";
import type { Activity, WalletEntry, WalletState, WalletStore } from "./store.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const ACTIVITIES: Activity[] = ["chat", "duty", "mail", "system", "hosting", "integration"];
const KINDS: WalletEntry["kind"][] = ["debit", "credit", "adjustment"];

/** First instant of the IST calendar month containing `now`, as epoch ms. */
function istMonthStart(now: number): number {
  const shifted = new Date(now + IST_OFFSET_MS);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - IST_OFFSET_MS;
}

const optionalNumber = (params: Record<string, unknown>, key: string): number | undefined => {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number`);
  }
  return value;
};
const requiredText = (params: Record<string, unknown>, key: string): string => {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
};
const optionalText = (params: Record<string, unknown>, key: string): string | undefined => {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
};
const paise = (params: Record<string, unknown>, key: string): number => {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer number of paise`);
  }
  return value;
};
const nonNegativePaise = (params: Record<string, unknown>, key: string): number | undefined => {
  if (params[key] === undefined) {
    return undefined;
  }
  const value = paise(params, key);
  if (value < 0) {
    throw new Error(`${key} must not be negative`);
  }
  return value;
};

const csvCell = (value: string | number): string => {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const rupees = (amountPaise: number) => (amountPaise / 100).toFixed(2);

function csvRow(entry: WalletEntry): string {
  const debit = entry.kind === "debit" ? entry : undefined;
  const tokens = debit?.charge === "tokens" ? debit : undefined;
  const service = debit?.charge === "service" ? debit : undefined;
  return [
    new Date(entry.at).toISOString(),
    entry.kind,
    debit?.charge ?? "",
    debit?.activity ?? "",
    entry.label,
    tokens?.model ?? service?.service ?? "",
    tokens
      ? tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
      : "",
    rupees(entry.amountPaise),
    rupees(entry.balanceAfterPaise),
    entry.kind === "credit" ? entry.reference : (entry.note ?? ""),
  ]
    .map(csvCell)
    .join(",");
}
const CSV_HEADER =
  "at,kind,charge,activity,label,model/service,tokens,amount ₹,balance after ₹,reference/note";

/** The Gateway client as far as `by` needs it; the host's profile carries `profileId`. */
type AdminClient = { authenticatedUserProfile?: { profileId?: string } } | null;

export function registerWalletGatewayMethods(deps: {
  api: OpenClawPluginApi;
  store: WalletStore;
  rateCard: () => RateCard;
  contact: () => string;
  notices: ReturnType<typeof createNotices>;
  events: { emit(name: "changed", payload: Record<string, unknown>): void };
  counters: { unrecorded: number };
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  lookups: AttributionLookups;
  now?: () => number;
}): void {
  const { api, store, rateCard, contact, notices, events, counters, request, lookups } = deps;
  const now = () => deps.now?.() ?? Date.now();

  // The ledger row is committed before notices and events run; a failing channel or listener
  // must not turn that committed write into a reported failure.
  const afterWrite = async (
    entry: WalletEntry | undefined,
    kind: string,
    notify: () => Promise<void>,
  ): Promise<void> => {
    try {
      await notify();
    } catch (error) {
      api.logger.warn(`wallet: notice failed: ${coerceErrorMessage(error)}`);
    }
    try {
      events.emit("changed", {
        balancePaise: await store.balance(),
        kind,
        entryId: entry?.id ?? "",
      });
    } catch {
      // Event delivery is best-effort.
    }
  };

  const register = (
    method: string,
    scope: Scope,
    handler: (params: Record<string, unknown>, ctx: Ctx) => Promise<unknown>,
  ) =>
    api.registerGatewayMethod(
      method,
      async (ctx: Ctx) => {
        try {
          ctx.respond(true, await handler(isRecord(ctx.params) ? ctx.params : {}, ctx));
        } catch (error) {
          ctx.respond(false, undefined, {
            code: "wallet_error",
            message: coerceErrorMessage(error),
          });
        }
      },
      { scope },
    );

  const actor = (ctx: Ctx): string =>
    (ctx.client as AdminClient)?.authenticatedUserProfile?.profileId ?? "operator";

  const listFilter = (params: Record<string, unknown>) => {
    const activity = optionalText(params, "activity");
    const kind = optionalText(params, "kind");
    if (activity !== undefined && !ACTIVITIES.includes(activity as Activity)) {
      throw new Error(`unknown activity: ${activity}`);
    }
    if (kind !== undefined && !KINDS.includes(kind as WalletEntry["kind"])) {
      throw new Error(`unknown kind: ${kind}`);
    }
    return {
      from: optionalNumber(params, "from"),
      to: optionalNumber(params, "to"),
      before: optionalNumber(params, "before"),
      ref: optionalText(params, "ref"),
      ...(activity ? { activity: activity as Activity } : {}),
      ...(kind ? { kind: kind as WalletEntry["kind"] } : {}),
    };
  };
  const defined = <T extends object>(filter: T): T =>
    Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)) as T;

  register("wallet.get", "operator.read", async (params) => {
    const at = now();
    const from = optionalNumber(params, "from") ?? istMonthStart(at);
    const to = optionalNumber(params, "to") ?? at;
    const [balancePaise, state, summary] = await Promise.all([
      store.balance(),
      store.getState(),
      store.summarize({ from, to }),
    ]);
    const days = await daysLeft(store, balancePaise + state.creditLimitPaise, at);
    return {
      balancePaise,
      state,
      daysLeft: days ?? null,
      period: { from, to },
      summary,
      contact: contact(),
      unrecorded: counters.unrecorded,
      rateCard: rateCard(),
    };
  });

  register("wallet.ledger", "operator.read", async (params) => {
    const requested = optionalNumber(params, "limit") ?? DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));
    const entries = await store.list({ ...defined(listFilter(params)), limit });
    const last = entries.at(-1);
    // The cursor is the integer entry id, so rows sharing a millisecond are never skipped.
    return {
      entries,
      ...(entries.length === limit && last ? { nextBefore: Number(last.id) } : {}),
    };
  });

  register("wallet.export", "operator.read", async (params) => {
    const entries = await store.list(defined(listFilter(params)));
    return { csv: [CSV_HEADER, ...entries.map(csvRow)].join("\n") };
  });

  register("wallet.gate", "operator.read", async () => {
    const verdict = evaluateGate(await store.getState(), await store.balance());
    return verdict.allowed ? verdict : { ...verdict, message: exhaustedMessage(contact()) };
  });

  register("wallet.credit", "operator.admin", async (params, ctx) => {
    const amountPaise = paise(params, "amountPaise");
    if (amountPaise <= 0) {
      throw new Error("amountPaise must be greater than zero");
    }
    const reference = requiredText(params, "reference");
    const note = optionalText(params, "note");
    const entry = await store.append({
      kind: "credit",
      source: "manual",
      reference,
      by: actor(ctx),
      amountPaise,
      label: "Recharge",
      ...(note ? { note } : {}),
    });
    if (entry.kind === "credit") {
      await afterWrite(entry, "credit", () => notices.afterCredit(entry));
    }
    return { entry };
  });

  register("wallet.adjust", "operator.admin", async (params, ctx) => {
    const amountPaise = paise(params, "amountPaise");
    if (amountPaise === 0) {
      throw new Error("amountPaise must not be zero");
    }
    const note = requiredText(params, "note");
    const entry = await store.append({
      kind: "adjustment",
      by: actor(ctx),
      amountPaise,
      label: "Adjustment",
      note,
    });
    await afterWrite(entry, "adjustment", () => notices.reconcile());
    return { entry };
  });

  register("wallet.settings", "operator.admin", async (params) => {
    const patch: Partial<WalletState> = {};
    const creditLimitPaise = nonNegativePaise(params, "creditLimitPaise");
    const lowBalancePaise = nonNegativePaise(params, "lowBalancePaise");
    if (creditLimitPaise !== undefined) {
      patch.creditLimitPaise = creditLimitPaise;
    }
    if (lowBalancePaise !== undefined) {
      patch.lowBalancePaise = lowBalancePaise;
    }
    if (params.enforce !== undefined) {
      if (typeof params.enforce !== "boolean") {
        throw new Error("enforce must be a boolean");
      }
      patch.enforce = params.enforce;
    }
    // An empty patch is valid: the Control UI calls it as an admin probe and gets the state back.
    if (Object.keys(patch).length > 0) {
      await store.setState(patch);
      await afterWrite(undefined, "settings", () => notices.reconcile());
    }
    return { state: await store.getState() };
  });

  // A double-clicked admin button must not import twice: overlapping calls share one run.
  let backfillInFlight: ReturnType<typeof backfillFromUsage> | undefined;
  register("wallet.backfill", "operator.admin", async () => {
    if (backfillInFlight) {
      return backfillInFlight;
    }
    const run = backfillFromUsage({
      store,
      rateCard,
      request,
      lookups,
      now,
      log: (message) => api.logger.warn(message),
    });
    backfillInFlight = run;
    try {
      const result = await run;
      if (!result.alreadyDone && result.days > 0) {
        await afterWrite(undefined, "debit", () => notices.reconcile());
      }
      return result;
    } finally {
      backfillInFlight = undefined;
    }
  });

  register("wallet.charge", "operator.write", async (params) => {
    const service = requiredText(params, "service");
    const units = optionalNumber(params, "units");
    if (units === undefined || units <= 0) {
      throw new Error("units must be a number greater than zero");
    }
    const priced = priceService(rateCard(), service, units);
    if (!priced) {
      throw new Error(`unknown service: ${service}`);
    }
    const activity = optionalText(params, "activity") as Activity | undefined;
    if (activity !== undefined && !ACTIVITIES.includes(activity)) {
      throw new Error(`unknown activity: ${activity}`);
    }
    const sessionKey = optionalText(params, "sessionKey");
    const runId = optionalText(params, "runId");
    const entry = await store.append({
      kind: "debit",
      charge: "service",
      activity: activity ?? "integration",
      ref: optionalText(params, "ref") ?? service,
      label:
        optionalText(params, "label") ??
        `${service.charAt(0).toUpperCase()}${service.slice(1)} — ${units} ${priced.unit}`,
      service,
      units,
      unit: priced.unit,
      unitRatePaise: priced.unitRatePaise,
      source: "live",
      amountPaise: -priced.paise,
      ...(sessionKey ? { sessionKey } : {}),
      ...(runId ? { runId } : {}),
    });
    await afterWrite(entry, "debit", () => notices.reconcile());
    return { entry };
  });
}
