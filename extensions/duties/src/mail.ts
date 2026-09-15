/**
 * Mail-trigger readiness, read straight off the canonical config so the owner is told which of the
 * four pieces of the Gmail → Duties path is missing instead of a bare "mail didn't work".
 *
 * Verified config paths (re-check before touching this file):
 * - `hooks.enabled` / `hooks.mappings` / `hooks.gmail` — `HooksConfig`
 *   (src/config/types.hooks.ts:29-60), reached from `OpenClawConfig.hooks`
 *   (src/config/types.openclaw.ts:236).
 * - `hooks.gmail.account` — optional string on `HooksGmailConfigInput`
 *   (src/config/zod-schema.hooks.ts:106,146).
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
  mappingPresent: boolean;
  agentPresent: boolean;
  lastDispatchAt?: number;
  lastDispatchDutyId?: string;
};

/** Never returns the Gmail address itself (only whether one is set) or any hook token: this is a
 *  readiness readout, shown on the Duties page and printed by the CLI. */
export function mailStatusFromConfig(config: OpenClawConfig, settings: DutiesSettings): MailStatus {
  const hooks = config.hooks;
  return {
    configured: hooks !== undefined,
    hooksEnabled: hooks?.enabled === true,
    gmailAccountSet: typeof hooks?.gmail?.account === "string" && hooks.gmail.account.length > 0,
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
