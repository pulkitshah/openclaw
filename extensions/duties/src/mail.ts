/**
 * Mail-trigger readiness, read straight off the canonical config so the owner is told which of the
 * four pieces of the Gmail → Duties path is missing instead of a bare "mail didn't work".
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
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { DutiesSettings } from "./store.js";

/** The agent id the Gmail hook mapping routes Duties mail to; also the marker `duty_run` reads to
 *  record a run as mail-triggered rather than chat- or manually-started. */
export const MAIL_AGENT_ID = "duties-mail";

export type MailStatus = {
  /** False only when `config.hooks` is entirely absent — the client desk profile default. A
   *  desk that has never been offered mail at all is a different state from one whose mail is
   *  half-wired: the Duties page shows neither the four checks nor the setup hint for it. */
  configured: boolean;
  hooksEnabled: boolean;
  gmailAccountSet: boolean;
  /** How many Gmail mailboxes are configured: the root `hooks.gmail.account` counts as one, or
   *  each `hooks.gmail.accounts.*` entry that carries its own address counts (root address is
   *  ignored once named accounts exist — see `src/hooks/gmail-accounts.ts`). Never the address(es)
   *  themselves, same as `gmailAccountSet`. */
  gmailAccountCount: number;
  /** Whether EVERY configured mailbox has a `hooks.mappings` entry that routes its own hook path to
   *  the Duties mail agent. False when any one of them has none: a named account is served on
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

/** Every distinct Gmail address configured (root, or each named `hooks.gmail.accounts.*` entry
 *  that carries its own address — the root is ignored once named accounts exist, see
 *  `src/hooks/gmail-accounts.ts`). Resolved here rather than imported from core: `extensions/**`
 *  must not import `src/**` (extensions/AGENTS.md), and this is a readiness readout, not the
 *  resolution owner.
 *
 *  Exported (unlike the rest of this file's "never return an address" discipline) because
 *  `cli.ts`'s `duties setup --account <email>` genuinely needs the address to compare against —
 *  it must not disagree with `mailStatusFromConfig` about whether an account is configured. */
export function configuredGmailAddresses(hooks: OpenClawConfig["hooks"]): string[] {
  return resolveGmailAccounts(hooks).map((account) => account.account);
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

/** Never returns the Gmail address itself (only whether/how many are set) or any hook token: this
 *  is a readiness readout, shown on the Duties page and printed by the CLI. */
export function mailStatusFromConfig(config: OpenClawConfig, settings: DutiesSettings): MailStatus {
  const hooks = config.hooks;
  const accounts = resolveGmailAccounts(hooks);
  const unmappedAccountIds = accounts
    .filter((account) => !accountHasMapping(hooks, account.accountId))
    .map((account) => account.accountId);
  // With no mailbox configured at all there is no account whose path could be checked, so the
  // mapping check falls back to "is there a Duties mail mapping at all" — `gmailAccountSet` is the
  // check that reports the missing mailbox, and this one must not double-report it.
  const mappingPresent =
    accounts.length === 0
      ? (hooks?.mappings ?? []).some((mapping) => mapping.agentId === MAIL_AGENT_ID)
      : unmappedAccountIds.length === 0;
  return {
    configured: hooks !== undefined,
    hooksEnabled: hooks?.enabled === true,
    gmailAccountSet: accounts.length > 0,
    gmailAccountCount: accounts.length,
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
