// Sms plugin module implements phone behavior.
import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/security-runtime";

export function normalizeSmsPhoneNumber(raw: string): string {
  const trimmed = raw
    .trim()
    .replace(/^(?:sms|twilio-sms):/i, "")
    .trim();
  if (!trimmed) {
    return "";
  }
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
  return withPlus.replace(/[^\d+]/g, "");
}

export function looksLikeSmsPhoneNumber(raw: string): boolean {
  const normalized = normalizeSmsPhoneNumber(raw);
  return /^\+[1-9]\d{6,14}$/.test(normalized);
}

export function normalizeSmsAllowFrom(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "*") {
    return "*";
  }
  // `accessGroup:<name>` is not a phone number. Phone normalization strips every non-digit, which
  // would reduce a reference to the bare "+" — an entry that survives filtering, matches nobody,
  // and still counts as a configured allowlist.
  if (parseAccessGroupAllowFromEntry(trimmed) != null) {
    return trimmed;
  }
  return normalizeSmsPhoneNumber(raw).toLowerCase();
}
