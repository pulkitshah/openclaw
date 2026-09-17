/**
 * Mail-trigger readiness, read straight off the canonical config so the owner is told which of the
 * four pieces of the Gmail → Duties path is missing instead of a bare "mail didn't work".
 *
 * Two transports feed the same dispatcher (`MAIL_AGENT_ID`): the `hooks.gmail`/Pub-Sub webhook
 * (needs a Google Cloud project + public exposure), and the generic `extensions/imap` plugin with
 * a Gmail app password (the Control UI's guided Gmail card, `ui/src/pages/channels/gmail-setup.ts`
 * — no cloud project, no public exposure). An IMAP account whose `agentId` is `MAIL_AGENT_ID` feeds
 * the dispatcher exactly like a Gmail hook mapping does, so this readout must recognize either one
 * or a correctly working IMAP desk reports "not configured".
 *
 * Verified config paths (re-check before touching this file):
 * - `hooks.enabled` / `hooks.mappings` / `hooks.gmail` — `HooksConfig`
 *   (src/config/types.hooks.ts:29-60), reached from `OpenClawConfig.hooks`
 *   (src/config/types.openclaw.ts:236).
 * - `hooks.gmail.account` / `hooks.gmail.accounts.*.account` — optional strings on
 *   `HooksGmailConfigInput` (src/config/zod-schema.hooks.ts:106,151,180).
 * - `hooks.mappings[].agentId` / `hooks.mappings[].match.path` — optional strings on
 *   `HookMappingConfigInput` (src/config/zod-schema.hooks.ts:46,76).
 * - `agents.entries` — `Record<string, AgentEntryConfig>` (src/config/types.agents.ts:113).
 * - `plugins.entries.imap.enabled` / `plugins.entries.imap.config.accounts.*.{user,agentId}` —
 *   `PluginEntryConfig` (src/config/types.plugins.ts); `config` is an untyped
 *   `Record<string, unknown>` there, so this file narrows it itself rather than importing
 *   `extensions/imap`'s private shape (extensions/** must not import another plugin's internals).
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { DutiesSettings } from "./store.js";

/** The agent id the Gmail hook mapping routes Duties mail to; also the marker `duty_run` reads to
 *  record a run as mail-triggered rather than chat- or manually-started. */
export const MAIL_AGENT_ID = "duties-mail";

export type MailStatus = {
  /** False only when neither transport is present at all — `config.hooks` is undefined and no
   *  `plugins.entries.imap` account targets the mail agent (the client desk profile default). A
   *  desk that has never been offered mail at all is a different state from one whose mail is
   *  half-wired: the Duties page shows neither the four checks nor the setup hint for it. */
  configured: boolean;
  /** True once either transport that feeds the mail agent is enabled: `hooks.enabled`, or an
   *  IMAP account targeting the mail agent whose `plugins.entries.imap.enabled` is `true`. */
  hooksEnabled: boolean;
  /** True once a mailbox is configured on either transport (a Gmail hook address, or an IMAP
   *  account targeting the mail agent). Never the address(es) themselves. */
  gmailAccountSet: boolean;
  /** How many mailboxes are configured across both transports: the root `hooks.gmail.account`
   *  counts as one, each `hooks.gmail.accounts.*` entry that carries its own address counts (root
   *  address is ignored once named accounts exist — see `src/hooks/gmail-accounts.ts`), and each
   *  `plugins.entries.imap.config.accounts.*` entry whose `agentId` is the mail agent counts too.
   *  Never the address(es) themselves, same as `gmailAccountSet`. */
  gmailAccountCount: number;
  /** Whether EVERY configured Gmail-hook mailbox has a `hooks.mappings` entry that routes its own
   *  hook path to the Duties mail agent, OR at least one IMAP account already targets the mail
   *  agent directly (an IMAP account's `agentId` IS its routing — it needs no separate mapping
   *  step). False when a Gmail-hook mailbox has none: a named account is served on
   *  `gmail-<accountId>`, and mail pushed to a path nothing matches is accepted by the watcher and
   *  then dropped, so one mapped mailbox must never report the whole path as healthy (final review
   *  C1). */
  mappingPresent: boolean;
  /** The account ids (never addresses) whose hook path no mapping matches, in resolution order.
   *  Omitted when there is no gap, so the Duties page can name the mailbox to fix. */
  unmappedAccountIds?: string[];
  agentPresent: boolean;
  lastDispatchAt?: number;
  lastDispatchDutyId?: string;
};

/** Every distinct Gmail address configured on either transport: the `hooks.gmail` root/named
 *  accounts, plus each IMAP account (`plugins.entries.imap`) whose `agentId` targets the mail
 *  agent. Resolved here rather than imported from core: `extensions/**` must not import `src/**`
 *  (extensions/AGENTS.md), and this is a readiness readout, not the resolution owner.
 *
 *  Exported (unlike the rest of this file's "never return an address" discipline) because
 *  `cli.ts`'s `duties setup --account <email>` genuinely needs the address to compare against —
 *  it must not disagree with `mailStatusFromConfig` about whether an account is configured. */
export function configuredGmailAddresses(config: OpenClawConfig): string[] {
  return [
    ...resolveGmailAccounts(config.hooks).map((account) => account.account),
    ...resolveImapMailAgentAccounts(config).map((account) => account.user),
  ];
}

/** The default account id and its hook path, spelled here rather than imported: these are
 *  `GMAIL_DEFAULT_ACCOUNT_ID` and `gmailHookPathForAccount` in `src/hooks/gmail-accounts.ts`, which
 *  owns the resolution, and `extensions/**` must not import `src/**` (extensions/AGENTS.md). Same
 *  reason `TEAM_ACCESS_GROUP_ENTRY` spells "accessGroup:" by hand in `team.ts`. A readiness readout
 *  is a reader of that contract, never a second owner of it. */
const GMAIL_DEFAULT_ACCOUNT_ID = "default";

function gmailHookPathForAccount(accountId: string): string {
  return accountId === GMAIL_DEFAULT_ACCOUNT_ID ? "gmail" : `gmail-${accountId}`;
}

/** Every configured mailbox as `{ accountId, account }`, mirroring `resolveGmailHookAccounts`: named
 *  `hooks.gmail.accounts.*` entries that carry their own address, or the root `hooks.gmail.account`
 *  as the default account when none are named. Unlike core's resolver this never throws on an
 *  account id that is not session-safe — a readiness readout reports, it never refuses — so such an
 *  account is still counted and still checked for a mapping. */
function resolveGmailAccounts(
  hooks: OpenClawConfig["hooks"],
): Array<{ accountId: string; account: string }> {
  const named = Object.entries(hooks?.gmail?.accounts ?? {})
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([accountId, entry]) => {
      const account = typeof entry?.account === "string" ? entry.account.trim() : "";
      return account ? [{ accountId, account }] : [];
    });
  if (named.length > 0) {
    return named;
  }
  const root = typeof hooks?.gmail?.account === "string" ? hooks.gmail.account.trim() : "";
  return root ? [{ accountId: GMAIL_DEFAULT_ACCOUNT_ID, account: root }] : [];
}

/** Whether a mapping to the Duties mail agent actually receives this account's pushes. A mapping
 *  with no `match.path` matches every hook path (`mappingMatches`, src/gateway/hooks-mapping.ts),
 *  so it serves every account; one with a path serves only the account whose path it names. Leading
 *  and trailing slashes are stripped the same way `normalizeHookMatchPath` strips them. */
function accountHasMapping(hooks: OpenClawConfig["hooks"], accountId: string): boolean {
  const wanted = gmailHookPathForAccount(accountId);
  return (hooks?.mappings ?? []).some((mapping) => {
    if (mapping.agentId !== MAIL_AGENT_ID) {
      return false;
    }
    const raw = typeof mapping.match?.path === "string" ? mapping.match.path.trim() : "";
    if (!raw) {
      return true;
    }
    return raw.replace(/^\/+/, "").replace(/\/+$/, "") === wanted;
  });
}

/** Every `plugins.entries.imap.config.accounts.*` entry whose `agentId` is the Duties mail agent —
 *  the IMAP equivalent of a Gmail hook mailbox. `extensions/imap`'s own config shape
 *  (`ImapAccountConfig` in `extensions/imap/src/config.ts`) is not imported: `config` is an
 *  untyped `Record<string, unknown>` on `PluginEntryConfig`, and one plugin must not import
 *  another's internals (extensions/AGENTS.md), so this narrows the shape it actually reads.
 *  Requires `plugins.entries.imap.enabled === true`: an account object alone does not mean the
 *  plugin is running, and this readout must not call an unconfigured/disabled plugin healthy. */
function resolveImapMailAgentAccounts(
  config: OpenClawConfig,
): Array<{ accountId: string; user: string }> {
  const imapEntry = config.plugins?.entries?.imap;
  if (imapEntry?.enabled !== true) {
    return [];
  }
  const accounts = imapEntry.config?.accounts;
  if (!isRecord(accounts)) {
    return [];
  }
  return Object.entries(accounts)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([accountId, entry]) => {
      if (!isRecord(entry) || entry.agentId !== MAIL_AGENT_ID || typeof entry.user !== "string") {
        return [];
      }
      const user = entry.user.trim();
      return user ? [{ accountId, user }] : [];
    });
}

/** Never returns the Gmail address itself (only whether/how many are set) or any hook token: this
 *  is a readiness readout, shown on the Duties page and printed by the CLI. */
export function mailStatusFromConfig(config: OpenClawConfig, settings: DutiesSettings): MailStatus {
  const hooks = config.hooks;
  const gmailAccounts = resolveGmailAccounts(hooks);
  const imapAccounts = resolveImapMailAgentAccounts(config);
  const unmappedAccountIds = gmailAccounts
    .filter((account) => !accountHasMapping(hooks, account.accountId))
    .map((account) => account.accountId);
  // With no Gmail-hook mailbox configured at all there is no account whose path could be checked,
  // so the mapping check falls back to "is there a Duties mail mapping at all" — `gmailAccountSet`
  // is the check that reports the missing mailbox, and this one must not double-report it. An IMAP
  // account already targets the mail agent directly (no separate mapping step exists for it), so
  // its presence alone satisfies this check regardless of the Gmail-hook state.
  const mappingPresent =
    imapAccounts.length > 0 ||
    (gmailAccounts.length === 0
      ? (hooks?.mappings ?? []).some((mapping) => mapping.agentId === MAIL_AGENT_ID)
      : unmappedAccountIds.length === 0);
  const accountCount = gmailAccounts.length + imapAccounts.length;
  return {
    configured: hooks !== undefined || imapAccounts.length > 0,
    hooksEnabled: hooks?.enabled === true || imapAccounts.length > 0,
    gmailAccountSet: accountCount > 0,
    gmailAccountCount: accountCount,
    mappingPresent,
    ...(unmappedAccountIds.length > 0 ? { unmappedAccountIds } : {}),
    agentPresent: config.agents?.entries?.[MAIL_AGENT_ID] !== undefined,
    ...(settings.lastMailDispatchAt !== undefined
      ? { lastDispatchAt: settings.lastMailDispatchAt }
      : {}),
    ...(settings.lastMailDispatchDutyId !== undefined
      ? { lastDispatchDutyId: settings.lastMailDispatchDutyId }
      : {}),
  };
}
