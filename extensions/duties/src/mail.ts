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
 * - `hooks.mappings[].agentId` — optional string on `HookMappingConfigInput`
 *   (src/config/zod-schema.hooks.ts:46,76).
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
  mappingPresent: boolean;
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
  const named = Object.values(hooks?.gmail?.accounts ?? {})
    .map((entry) => entry?.account)
    .filter((account): account is string => typeof account === "string" && account.length > 0);
  if (named.length > 0) return named;
  const root = hooks?.gmail?.account;
  return typeof root === "string" && root.length > 0 ? [root] : [];
}

function countGmailAccounts(hooks: OpenClawConfig["hooks"]): number {
  return configuredGmailAddresses(hooks).length;
}

/** Never returns the Gmail address itself (only whether/how many are set) or any hook token: this
 *  is a readiness readout, shown on the Duties page and printed by the CLI. */
export function mailStatusFromConfig(config: OpenClawConfig, settings: DutiesSettings): MailStatus {
  const hooks = config.hooks;
  const gmailAccountCount = countGmailAccounts(hooks);
  return {
    configured: hooks !== undefined,
    hooksEnabled: hooks?.enabled === true,
    gmailAccountSet: gmailAccountCount > 0,
    gmailAccountCount,
    mappingPresent: (hooks?.mappings ?? []).some((m) => m.agentId === MAIL_AGENT_ID),
    agentPresent: config.agents?.entries?.[MAIL_AGENT_ID] !== undefined,
    ...(settings.lastMailDispatchAt !== undefined
      ? { lastDispatchAt: settings.lastMailDispatchAt }
      : {}),
    ...(settings.lastMailDispatchDutyId !== undefined
      ? { lastDispatchDutyId: settings.lastMailDispatchDutyId }
      : {}),
  };
}
