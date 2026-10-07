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
    const daysText = days === 1 ? "1 day" : `about ${days} days`;
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
