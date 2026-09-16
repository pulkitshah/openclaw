/**
 * Gmail hook accounts.
 *
 * Email accounts are workspace inboxes, not people: a Gmail account is not "a person's Gmail
 * identity" the way a Slack handle is, so it lives here at the connection layer and never reaches
 * channel ingress, a `ChannelId`, or the Team roster.
 *
 * The shape follows the convention this repo already uses for channels
 * (`src/config/channel-account-config.ts`): root keys are the default account's own values AND the
 * shared defaults for named accounts, `accounts.<id>` are shallow-merged over them, and
 * `defaultAccount` names one. `account` (the address) is deliberately NOT inherited, the way
 * WhatsApp excludes `authDir`/`name` from shared defaults — an address must never leak sideways
 * into a sibling account.
 *
 * Once `hooks.gmail.accounts` has any entries, the root `account` stops being an independent
 * mailbox of its own: it (and every other root field) is purely the shared defaults for the named
 * accounts. Mixing "one unnamed root mailbox" with "named accounts" is not supported — name every
 * mailbox once you add a second one.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Borrowed from IMAP's account id grammar (`extensions/imap/src/config.ts:52`) because the id
 *  reaches a session key. */
export const GMAIL_ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const GMAIL_DEFAULT_ACCOUNT_ID = "default";

/** The default account keeps the existing `gmail` hook path, so every already-deployed mapping and
 *  `hooks.allowedSessionKeyPrefixes: ["hook:gmail:"]` keep working untouched. */
export function gmailHookPathForAccount(accountId: string): string {
  return accountId === GMAIL_DEFAULT_ACCOUNT_ID ? "gmail" : `gmail-${accountId}`;
}

export function isGmailHookPath(hookPath: string | undefined): boolean {
  if (!hookPath) return false;
  return hookPath === "gmail" || hookPath.startsWith("gmail-");
}

export type ResolvedGmailAccount = { accountId: string; account: string };

/** Every configured mailbox, sorted by account id so callers and evidence are deterministic. */
export function resolveGmailHookAccounts(cfg: OpenClawConfig): ResolvedGmailAccount[] {
  const gmail = cfg.hooks?.gmail;
  if (!gmail) return [];
  const named = gmail.accounts ?? {};
  const ids = Object.keys(named);
  if (ids.length === 0) {
    const account = gmail.account?.trim() ?? "";
    return account ? [{ accountId: GMAIL_DEFAULT_ACCOUNT_ID, account }] : [];
  }
  const resolved: ResolvedGmailAccount[] = [];
  for (const accountId of ids.toSorted()) {
    if (!GMAIL_ACCOUNT_ID_RE.test(accountId)) {
      throw new Error(
        `Gmail account id "${accountId}" is not session-safe: use letters, digits, - and _ only`,
      );
    }
    const account = named[accountId]?.account?.trim() ?? "";
    // An address is per-account by definition; a root `account` is the DEFAULT account's address,
    // never a fallback for a named one.
    if (account) resolved.push({ accountId, account });
  }
  return resolved;
}
