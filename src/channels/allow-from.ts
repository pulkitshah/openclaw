/**
 * Channel allowFrom policy helpers.
 *
 * Merges DM/group allowlists and checks normalized sender entries.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/**
 * Prefix that marks an allowFrom entry as an access-group reference instead of a sender id.
 */
export const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";

/**
 * Parses an access-group allowFrom entry and returns the referenced group name.
 */
export function parseAccessGroupAllowFromEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(ACCESS_GROUP_ALLOW_FROM_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(ACCESS_GROUP_ALLOW_FROM_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

/**
 * Separator between the channel id and the channel account id in a `message.senders` member key.
 */
const MESSAGE_SENDER_GROUP_ACCOUNT_SEPARATOR = ":";

/**
 * Builds the account-scoped `message.senders` member key for one channel account.
 */
export function messageSenderGroupAccountKey(channelId: string, accountId: string): string {
  return `${channelId}${MESSAGE_SENDER_GROUP_ACCOUNT_SEPARATOR}${accountId}`;
}

/**
 * Returns the channel id a `message.senders` member key applies to, dropping any account scope.
 */
export function messageSenderGroupKeyChannelId(key: string): string {
  const separator = key.indexOf(MESSAGE_SENDER_GROUP_ACCOUNT_SEPARATOR);
  return separator > 0 ? key.slice(0, separator) : key;
}

/**
 * Selects the `message.senders` entries that apply to one channel account.
 *
 * Three key forms, widest first: `"*"` for every channel, `"<channelId>"` for every account of
 * that channel, and `"<channelId>:<accountId>"` for that one account only. The scoped form is the
 * only way a member reaches exactly one account of a multi-account channel; without it a member
 * listed for one account authorizes on all of them.
 */
export function messageSenderGroupEntries(params: {
  members: Record<string, string[]>;
  channelId: string;
  accountId?: string;
}): string[] {
  const scopedKey = params.accountId
    ? messageSenderGroupAccountKey(params.channelId, params.accountId)
    : undefined;
  return [
    ...(params.members["*"] ?? []),
    ...(params.members[params.channelId] ?? []),
    ...(scopedKey && scopedKey !== params.channelId ? (params.members[scopedKey] ?? []) : []),
  ];
}

/**
 * Merges configured DM allowFrom entries with pairing-store sender ids when policy allows it.
 */
export function mergeDmAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
  dmPolicy?: string;
}): string[] {
  const storeEntries =
    params.dmPolicy === "allowlist" || params.dmPolicy === "open"
      ? []
      : (params.storeAllowFrom ?? []);
  return normalizeStringEntries([...(params.allowFrom ?? []), ...storeEntries]);
}

/**
 * Resolves the allowFrom entries used for group chats, optionally falling back to DM policy.
 */
export function resolveGroupAllowFromSources(params: {
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  fallbackToAllowFrom?: boolean;
}): string[] {
  const explicitGroupAllowFrom =
    Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : undefined;
  const scoped = explicitGroupAllowFrom
    ? explicitGroupAllowFrom
    : params.fallbackToAllowFrom === false
      ? []
      : (params.allowFrom ?? []);
  return normalizeStringEntries(scoped);
}

/**
 * Returns the first value that is present, preserving falsy values such as false, 0, and "".
 */
export function firstDefined<T>(...values: Array<T | undefined>) {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Checks a normalized sender allowlist with wildcard and empty-list policy handling.
 */
export function isSenderIdAllowed(
  allow: { entries: string[]; hasWildcard: boolean; hasEntries: boolean },
  senderId: string | undefined,
  allowWhenEmpty: boolean,
): boolean {
  if (!allow.hasEntries) {
    return allowWhenEmpty;
  }
  if (allow.hasWildcard) {
    return true;
  }
  // A non-empty allowlist without wildcard needs a concrete sender id match.
  if (!senderId) {
    return false;
  }
  return allow.entries.includes(senderId);
}
