// Telegram plugin module implements access groups behavior.
import type { DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expandAllowFromWithAccessGroups } from "openclaw/plugin-sdk/security-runtime";
import {
  isSenderAllowed,
  normalizeAllowFrom,
  normalizeDmAllowFromWithStore,
  type NormalizedAllowFrom,
} from "./bot-access.js";

/**
 * Appends the concrete sender id when an `accessGroup:<name>` reference in this allowlist admits
 * them, leaving the references themselves in place.
 *
 * Telegram needs the concrete id because `shouldSkipTelegramGroupMessage` decides group admission
 * synchronously, before the shared ingress resolver runs. Membership itself is never decided here:
 * `expandAllowFromWithAccessGroups` (`src/plugin-sdk/access-groups.ts`) is the only matcher, and
 * the documented compatibility path for callers that still need a flat allowlist
 * (`docs/channels/access-groups.md`).
 *
 * The references are deliberately NOT dropped, on a match or otherwise. They are what tells
 * `normalizeAllowFrom` that an allowlist is configured, and what lets the shared resolver reach
 * the same verdict from the raw list.
 */
export async function expandTelegramAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  accountId?: string;
  senderId?: string;
}): Promise<string[]> {
  const allowFrom = (params.allowFrom ?? []).map(String);
  const senderId = params.senderId?.trim() ?? "";
  if (!params.cfg || !senderId) {
    return allowFrom;
  }
  return await expandAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom,
    channel: "telegram",
    accountId: params.accountId ?? "default",
    senderId,
    isSenderAllowed: (candidateSenderId, allowEntries) =>
      isSenderAllowed({
        allow: normalizeAllowFrom(allowEntries),
        senderId: candidateSenderId,
      }),
  });
}

export async function resolveTelegramDmAllow(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  groupAllowOverride?: Array<string | number>;
  storeAllowFrom?: string[];
  dmPolicy?: DmPolicy;
  accountId?: string;
  senderId?: string;
}): Promise<{
  allowFrom?: Array<string | number>;
  expandedAllowFrom: string[];
  effectiveAllow: NormalizedAllowFrom;
}> {
  const allowFrom = params.groupAllowOverride ?? params.allowFrom;
  const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom,
    accountId: params.accountId,
    senderId: params.senderId,
  });
  return {
    allowFrom,
    expandedAllowFrom,
    effectiveAllow: normalizeDmAllowFromWithStore({
      allowFrom: expandedAllowFrom,
      storeAllowFrom: params.storeAllowFrom,
      dmPolicy: params.dmPolicy,
    }),
  };
}
