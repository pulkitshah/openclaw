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
    .sort((a, b) => Math.abs(b.paise) - Math.abs(a.paise))
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
  } else {
    // Remove trailing period if no days clause
    if (!text.endsWith(".")) {
      text += ".";
    }
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

/** Validates and narrows gateway result into WalletGetResult type. */
function readWalletGetResult(value: unknown): WalletGetResult {
  if (!isRecord(value)) {
    throw new Error("wallet.get returned an unexpected shape");
  }

  // Validate balancePaise
  if (typeof value.balancePaise !== "number") {
    throw new Error("wallet.get returned an unexpected shape");
  }

  // Validate state
  if (!isRecord(value.state)) {
    throw new Error("wallet.get returned an unexpected shape");
  }
  const state = value.state as Record<string, unknown>;
  if (
    typeof state.creditLimitPaise !== "number" ||
    typeof state.lowBalancePaise !== "number" ||
    typeof state.enforce !== "boolean"
  ) {
    throw new Error("wallet.get returned an unexpected shape");
  }

  // Validate daysLeft
  if (value.daysLeft !== null && typeof value.daysLeft !== "number") {
    throw new Error("wallet.get returned an unexpected shape");
  }

  // Validate summary
  if (!isRecord(value.summary)) {
    throw new Error("wallet.get returned an unexpected shape");
  }
  const summary = value.summary as Record<string, unknown>;
  if (!Array.isArray(summary.buckets) || typeof summary.totalPaise !== "number") {
    throw new Error("wallet.get returned an unexpected shape");
  }

  // Validate contact
  if (typeof value.contact !== "string") {
    throw new Error("wallet.get returned an unexpected shape");
  }

  // Build result from validated fields
  return {
    balancePaise: value.balancePaise,
    state: value.state as WalletState,
    daysLeft: value.daysLeft as number | null,
    summary: value.summary as Summary,
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
  } as AnyAgentTool;
}

/** Creates a /wallet command that calls wallet.get and returns formatted status. */
export function createWalletCommand(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  unavailableText: string = "Wallet is unavailable right now — try again in a minute.",
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
