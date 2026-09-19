// Telegram plugin module implements bot access behavior.
import {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
} from "openclaw/plugin-sdk/allow-from";
import type {
  DmPolicy,
  TelegramDirectConfig,
  TelegramGroupConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";

export type NormalizedAllowFrom = {
  /** Concrete numeric Telegram sender user ids this allowlist matches directly. */
  entries: string[];
  hasWildcard: boolean;
  /**
   * Whether an allowlist is configured at all — not whether it has matchable sender ids.
   *
   * `accessGroup:<name>` references count: they are a configured restriction whose membership is
   * resolved by the shared ingress resolver, not by this normalizer. Treating a
   * group-reference-only list as unconfigured would make Telegram's "chat listed in `groups`, no
   * sender allowlist" shortcut admit everybody (`group-access.ts`'s `allowlistMatched`).
   */
  hasEntries: boolean;
  invalidEntries: string[];
  /** `accessGroup:<name>` references, kept verbatim for the shared ingress resolver to resolve. */
  accessGroupRefs: string[];
};

// Telegram owns this process-local warning bound; authorization output stays unchanged.
const warnedInvalidEntries = createDedupeCache({ ttlMs: 0, maxSize: 256 });
const log = createSubsystemLogger("telegram/bot-access");

function warnInvalidAllowFromEntries(entries: string[]) {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  for (const entry of entries) {
    if (warnedInvalidEntries.check(entry)) {
      continue;
    }
    log.warn(
      [
        "Invalid allowFrom entry:",
        JSON.stringify(entry),
        "- allowFrom/groupAllowFrom authorization expects numeric Telegram sender user IDs only.",
        'To allow a Telegram group or supergroup, add its negative chat ID under "channels.telegram.groups" instead.',
        'If you had "@username" entries, re-run setup (it resolves @username to IDs) or replace them manually.',
      ].join(" "),
    );
  }
}

export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? [])
    .map((value) => normalizeOptionalString(String(value)) ?? "")
    .filter(Boolean);
  const hasWildcard = entries.includes("*");
  // Access-group references are separated out before any sender-id normalization: `accessGroup:`
  // is channel-agnostic allowlist syntax, so stripping the `telegram:` prefix or applying the
  // numeric-id rule to it would turn a valid reference into an invalid sender id.
  const accessGroupRefs = entries.filter((value) => parseAccessGroupAllowFromEntry(value) != null);
  const normalized = entries
    .filter((value) => value !== "*" && parseAccessGroupAllowFromEntry(value) == null)
    .map((value) => value.replace(/^(telegram|tg):/i, ""));
  const invalidEntries = normalized.filter((value) => !/^\d+$/.test(value));
  if (invalidEntries.length > 0) {
    warnInvalidAllowFromEntries(uniqueStrings(invalidEntries));
  }
  const ids = normalized.filter((value) => /^\d+$/.test(value));
  return {
    entries: ids,
    hasWildcard,
    hasEntries: entries.length > 0,
    invalidEntries,
    accessGroupRefs,
  };
};

export const normalizeDmAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: string[];
  dmPolicy?: string;
}): NormalizedAllowFrom => normalizeAllowFrom(mergeDmAllowFromSources(params));

export function resolveTelegramEffectiveDmPolicy(params: {
  isGroup: boolean;
  groupConfig?: TelegramDirectConfig | TelegramGroupConfig;
  dmPolicy?: DmPolicy;
}): DmPolicy {
  if (!params.isGroup && params.groupConfig && "dmPolicy" in params.groupConfig) {
    return params.groupConfig.dmPolicy ?? params.dmPolicy ?? "pairing";
  }
  return params.dmPolicy ?? "pairing";
}

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}) => {
  const { allow, senderId } = params;
  return isSenderIdAllowed(allow, senderId, true);
};

export { firstDefined };
