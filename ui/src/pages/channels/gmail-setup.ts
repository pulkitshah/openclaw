// Gmail connection card for the Channels hub: a guided setup that writes an
// `extensions/imap` account rather than Duties' hooks.gmail/Pub-Sub mechanism.
// hooks.gmail needs a real Google Cloud project, gcloud auth, and Tailscale
// public exposure, so it cannot be a smooth guided wizard for a non-technical
// owner. IMAP with a Gmail "app password" needs neither: it polls/IDLEs
// outward from the desk. Pointing the account's `agentId` at "duties-mail"
// feeds Duties' mail dispatcher exactly like the Gmail hook does today (see
// extensions/duties/src/mail.ts, which recognizes this same account shape).
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";

/** Synthetic hub card id: not a real two-way channel plugin (see AGENTS notes
 *  in view.ts), so it never appears in the server's channels.status snapshot. */
export const GMAIL_HUB_CHANNEL_ID = "gmail";
/** Fixed account id the wizard writes/reads under `plugins.entries.imap.config.accounts`. */
export const GMAIL_IMAP_ACCOUNT_ID = "gmail";
export const GMAIL_IMAP_HOST = "imap.gmail.com";
export const GMAIL_IMAP_PORT = 993;
/** Matches extensions/duties/src/mail.ts's MAIL_AGENT_ID; duplicated rather than
 *  imported because ui/** must not import extensions/** runtime internals. */
export const DUTIES_MAIL_AGENT_ID = "duties-mail";

const GMAIL_ACCOUNT_PATH = [
  "plugins",
  "entries",
  "imap",
  "config",
  "accounts",
  GMAIL_IMAP_ACCOUNT_ID,
] as const;
const GMAIL_ALLOWED_SENDERS_PATH = `${GMAIL_ACCOUNT_PATH.join(".")}.allowedSenders`;

export type GmailSetupStep = "intro" | "form";
export type GmailSetupFieldName = "email" | "appPassword" | "allowedSenders";

export type GmailSetupFormState = {
  step: GmailSetupStep;
  email: string;
  appPassword: string;
  passwordVisible: boolean;
  allowedSenders: string;
  saving: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
};

/** Reads the wizard-owned IMAP account out of a config document (form draft or snapshot). */
export function resolveGmailImapAccount(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const plugins = asNullableRecord(config?.plugins);
  const entries = asNullableRecord(plugins?.entries);
  const imap = asNullableRecord(entries?.imap);
  const imapConfig = asNullableRecord(imap?.config);
  const accounts = asNullableRecord(imapConfig?.accounts);
  return asNullableRecord(accounts?.[GMAIL_IMAP_ACCOUNT_ID]);
}

export function isGmailImapConfigured(config: Record<string, unknown> | null | undefined): boolean {
  const account = resolveGmailImapAccount(config);
  return typeof account?.user === "string" && account.user.trim().length > 0;
}

function resolveGmailAllowedSenders(account: Record<string, unknown> | null): string {
  const senders = Array.isArray(account?.allowedSenders) ? account.allowedSenders : [];
  return senders.filter((entry): entry is string => typeof entry === "string").join(", ");
}

export function createGmailSetupFormState(
  config: Record<string, unknown> | null | undefined,
): GmailSetupFormState {
  const account = resolveGmailImapAccount(config);
  return {
    step: "intro",
    email: typeof account?.user === "string" ? account.user : "",
    appPassword: "",
    passwordVisible: false,
    allowedSenders: resolveGmailAllowedSenders(account),
    saving: false,
    error: null,
    fieldErrors: {},
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
// Loose "local@domain" or "@domain" allowlist entry check; the real
// authenticity gate is extensions/imap's DKIM/DMARC-based sender-auth, so this
// only rejects obviously malformed entries.
const SENDER_ENTRY_PATTERN = /^@?[^\s@]+(?:@[^\s@]+)?$/u;

export function parseGmailAllowedSenders(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\n]/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

export function validateGmailSetupForm(state: GmailSetupFormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!EMAIL_PATTERN.test(state.email.trim())) {
    errors.email = t("channels.gmail.errors.email");
  }
  if (state.appPassword.replace(/\s+/gu, "").length < 8) {
    errors.appPassword = t("channels.gmail.errors.appPassword");
  }
  const senders = parseGmailAllowedSenders(state.allowedSenders);
  if (senders.length === 0) {
    errors.allowedSenders = t("channels.gmail.errors.allowedSendersRequired");
  } else if (senders.some((entry) => !SENDER_ENTRY_PATTERN.test(entry))) {
    errors.allowedSenders = t("channels.gmail.errors.allowedSendersFormat");
  }
  return errors;
}

function buildGmailImapAccount(state: GmailSetupFormState): Record<string, unknown> {
  return {
    host: GMAIL_IMAP_HOST,
    port: GMAIL_IMAP_PORT,
    secure: true,
    user: state.email.trim(),
    password: state.appPassword.replace(/\s+/gu, ""),
    mailbox: "INBOX",
    agentId: DUTIES_MAIL_AGENT_ID,
    allowedSenders: parseGmailAllowedSenders(state.allowedSenders),
    watch: { mode: "auto", pollSeconds: 60 },
    includeBody: true,
    deliver: false,
  };
}

export type GmailSetupWriteResult = { ok: true } | { ok: false; error: string };

/** Writes the Gmail IMAP account and enables the imap plugin in one commit,
 *  independent of the page's advanced-config draft (mirrors patchMcpServers in
 *  ../../lib/config/mcp-servers.ts). */
export async function saveGmailImapAccount(
  runtimeConfig: RuntimeConfigCapability,
  state: GmailSetupFormState,
): Promise<GmailSetupWriteResult> {
  try {
    await runtimeConfig.ensureLoaded();
    const patched = await runtimeConfig.patchFromSnapshot(() => ({
      options: {
        raw: {
          plugins: {
            entries: {
              imap: {
                enabled: true,
                config: { accounts: { [GMAIL_IMAP_ACCOUNT_ID]: buildGmailImapAccount(state) } },
              },
            },
          },
        },
        note: "Connect Gmail (IMAP)",
        // allowedSenders can shrink on a reconfigure; name the path so the
        // gateway's destructive-array guard allows the intentional replace.
        replacePaths: [GMAIL_ALLOWED_SENDERS_PATH],
      },
    }));
    if (!patched) {
      return {
        ok: false,
        error: runtimeConfig.state.lastError ?? t("channels.gmail.errors.saveFailed"),
      };
    }
    await runtimeConfig.refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatUiError(error) };
  }
}

/** Clears the wizard-owned account only; other IMAP accounts a power user
 *  configured by hand are untouched (RFC 7396 merge-patch null deletion). */
export async function removeGmailImapAccount(
  runtimeConfig: RuntimeConfigCapability,
): Promise<GmailSetupWriteResult> {
  try {
    await runtimeConfig.ensureLoaded();
    const patched = await runtimeConfig.patchFromSnapshot(() => ({
      options: {
        raw: {
          plugins: {
            entries: { imap: { config: { accounts: { [GMAIL_IMAP_ACCOUNT_ID]: null } } } },
          },
        },
        note: "Disconnect Gmail (IMAP)",
      },
    }));
    if (!patched) {
      return {
        ok: false,
        error: runtimeConfig.state.lastError ?? t("channels.gmail.errors.removeFailed"),
      };
    }
    await runtimeConfig.refresh();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: formatUiError(error) };
  }
}
