import { jsonResult } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  OpenClawPluginCommandDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { evaluateGate } from "./gate.js";
import { formatInr } from "./money.js";
import type { WalletState, Summary, Activity } from "./store.js";

const BUCKET_NAMES: Record<Activity, string> = {
  chat: "Chat",
  duty: "Duties",
  mail: "Mail",
  system: "System",
  hosting: "Hosting",
  integration: "Integrations",
};

/**
 * Formats wallet balance and usage into a human-readable status text.
 *
 * Example: "₹1,240.00 left · ₹310.00 this month (Duties ₹212.00, Chat ₹71.00, Hosting ₹24.00, System ₹3.00) · about 9 days at this rate."
 *
 * When paused: "Paused — ₹1,240.00 left · ₹310.00 this month (Duties ₹212.00, Chat ₹71.00, Hosting ₹24.00, System ₹3.00) · about 9 days at this rate. Ask TripIn Studio to recharge."
 */
export function walletStatusText(get: {
  balancePaise: number;
  state: WalletState;
  daysLeft: number | null;
  summary: Summary;
  contact: string;
}): string {
  const paused = evaluateGate(get.state, get.balancePaise).allowed === false;

  // Format balance (always positive display)
  const balanceText = formatInr(get.balancePaise);

  // Format total spent this month (display as positive)
  const totalSpentText = formatInr(-get.summary.totalPaise);

  // Format buckets in descending order, omit zeros
  const buckets = get.summary.buckets
    .filter((b) => b.paise !== 0)
    .toSorted((a, b) => Math.abs(b.paise) - Math.abs(a.paise))
    .map((b) => {
      const name = BUCKET_NAMES[b.activity] ?? b.activity;
      const amount = formatInr(-b.paise); // negate to display as positive
      return `${name} ${amount}`;
    });

  const bucketsText = buckets.length > 0 ? `(${buckets.join(", ")})` : "";

  // Build the main status
  let text = `${balanceText} left · ${totalSpentText} this month ${bucketsText}`.trim();

  // Add days left clause if available
  if (get.daysLeft !== null) {
    const days = get.daysLeft;
    const daysText = days === 1 ? "about 1 day" : `about ${days} days`;
    text += ` · ${daysText} at this rate.`;
  } else if (!text.endsWith(".")) {
    // No days clause: end the sentence here.
    text += ".";
  }

  const topModels = get.summary.models
    .filter((m) => m.paise !== 0)
    .toSorted((a, b) => a.paise - b.paise)
    .slice(0, 3)
    .map((m) => `${m.label} ${formatInr(-m.paise)}`);
  if (topModels.length > 0) {
    text += ` Models: ${topModels.join(", ")}.`;
  }

  // Add pause status
  if (paused) {
    text = `Paused — ${text} Ask ${get.contact} to recharge.`;
  }

  return text;
}

export type WalletGetResult = {
  balancePaise: number;
  state: WalletState;
  daysLeft: number | null;
  summary: Summary;
  contact: string;
};

const ACTIVITIES: readonly Activity[] = [
  "chat",
  "duty",
  "mail",
  "system",
  "hosting",
  "integration",
];
const SHAPE_ERROR = "wallet.get returned an unexpected shape";

function readNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(SHAPE_ERROR);
  }
  return value;
}

function readState(value: unknown): WalletState {
  if (!isRecord(value) || typeof value.enforce !== "boolean") {
    throw new Error(SHAPE_ERROR);
  }
  return {
    creditLimitPaise: readNumber(value.creditLimitPaise),
    lowBalancePaise: readNumber(value.lowBalancePaise),
    enforce: value.enforce,
    ...(typeof value.stoppedSince === "number" ? { stoppedSince: value.stoppedSince } : {}),
  };
}

function readActivity(value: unknown): Activity {
  const activity = ACTIVITIES.find((a) => a === value);
  if (!activity) {
    throw new Error(SHAPE_ERROR);
  }
  return activity;
}

function readModels(value: unknown): Summary["models"] {
  if (!Array.isArray(value)) {
    throw new Error(SHAPE_ERROR);
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.provider !== "string" ||
      typeof entry.model !== "string" ||
      typeof entry.label !== "string" ||
      typeof entry.unpriced !== "boolean"
    ) {
      throw new Error(SHAPE_ERROR);
    }
    return {
      provider: entry.provider,
      model: entry.model,
      label: entry.label,
      paise: readNumber(entry.paise),
      tokens: readNumber(entry.tokens),
      input: readNumber(entry.input),
      output: readNumber(entry.output),
      cacheRead: readNumber(entry.cacheRead),
      cacheWrite: readNumber(entry.cacheWrite),
      calls: readNumber(entry.calls),
      unpriced: entry.unpriced,
    };
  });
}

function readSummary(value: unknown): Summary {
  if (!isRecord(value) || !Array.isArray(value.buckets)) {
    throw new Error(SHAPE_ERROR);
  }
  const buckets = value.buckets.map((bucket) => {
    if (!isRecord(bucket) || !Array.isArray(bucket.activities)) {
      throw new Error(SHAPE_ERROR);
    }
    return {
      activity: readActivity(bucket.activity),
      paise: readNumber(bucket.paise),
      tokens: readNumber(bucket.tokens),
      activities: bucket.activities.map((entry) => {
        if (!isRecord(entry) || typeof entry.ref !== "string" || typeof entry.label !== "string") {
          throw new Error(SHAPE_ERROR);
        }
        return {
          ref: entry.ref,
          label: entry.label,
          paise: readNumber(entry.paise),
          tokens: readNumber(entry.tokens),
          entries: readNumber(entry.entries),
        };
      }),
    };
  });
  return {
    totalPaise: readNumber(value.totalPaise),
    tokens: readNumber(value.tokens),
    models: readModels(value.models),
    buckets,
  };
}

export function readWalletGetResult(value: unknown): WalletGetResult {
  if (!isRecord(value) || typeof value.contact !== "string") {
    throw new Error(SHAPE_ERROR);
  }
  const daysLeft = value.daysLeft === null ? null : readNumber(value.daysLeft);
  return {
    balancePaise: readNumber(value.balancePaise),
    state: readState(value.state),
    daysLeft,
    summary: readSummary(value.summary),
    contact: value.contact,
  };
}

/** Creates a wallet_status tool that calls wallet.get and returns formatted status. */
export function createWalletStatusTool(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): AnyAgentTool {
  return {
    name: "wallet_status",
    label: "Wallet Status",
    description: "Get current wallet balance, usage this month, and days remaining.",
    parameters: Type.Object({}),
    execute: async () => {
      const result = await request("wallet.get", {});
      const get = readWalletGetResult(result);
      const text = walletStatusText(get);
      return jsonResult({ text, balancePaise: get.balancePaise, state: get.state });
    },
  };
}

/** Creates a /wallet command that calls wallet.get and returns formatted status. */
export function createWalletCommand(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  unavailableText = "Wallet is unavailable right now — try again in a minute.",
): OpenClawPluginCommandDefinition {
  return {
    name: "wallet",
    description: "Balance and where it went this month.",
    acceptsArgs: false,
    handler: async () => {
      try {
        const result = await request("wallet.get", {});
        const get = readWalletGetResult(result);
        const text = walletStatusText(get);
        return { text };
      } catch {
        return { text: unavailableText };
      }
    },
  };
}
