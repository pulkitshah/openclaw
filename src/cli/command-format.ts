// Formats CLI command examples with active container/profile hints when they apply.
import { normalizeProfileName } from "./profile-utils.js";

// Both published bin names (see package.json's `bin` map). Displayed commands
// spell the product (`vasudev …`); the installed binary is still also
// `openclaw`, and upstream-authored strings keep using it, so the decoration
// below has to recognise either alias or it silently stops appending the
// active `--profile`/`--container`.
const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+(?:openclaw|vasudev)\b|^(?:openclaw|vasudev)\b/;
const CONTAINER_FLAG_RE = /(?:^|\s)--container(?:\s|=|$)/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;
const UPDATE_RE = /^(?:\s+--(?:dev|no-color|(?:profile|log-level)[=\s]+\S+))*\s+update(?:\s|$)/;
const CONTAINER_HINT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
// Owner of the *displayed* binary name. A command assembled from argv (the
// update handoff builds one from `resolveUpdateCliArgv`) cannot carry the
// product spelling in a literal, so normalizing it here is what keeps every
// displayed command on-brand instead of scattering the alias through call
// sites. Both names are real bins, so the rendered command still runs.
const CLI_DISPLAY_NAME = "vasudev";
const CLI_BINARY_TOKEN_RE = /^((?:pnpm|npm|bunx|npx)\s+)?openclaw\b/;

function withDisplayBinaryName(command: string): string {
  return command.replace(
    CLI_BINARY_TOKEN_RE,
    (_match, runner) => `${runner ?? ""}${CLI_DISPLAY_NAME}`,
  );
}

/** Add active root options to a displayed command without duplicating explicit flags. */
export function formatCliCommand(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const rawContainer = env.OPENCLAW_CONTAINER_HINT?.trim();
  const container = rawContainer && CONTAINER_HINT_RE.test(rawContainer) ? rawContainer : undefined;
  const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
  if (!CLI_PREFIX_RE.test(command)) {
    return command;
  }
  if (!container && !profile) {
    return withDisplayBinaryName(command);
  }
  const additions: string[] = [];
  if (
    container &&
    !CONTAINER_FLAG_RE.test(command) &&
    !UPDATE_RE.test(command.replace(CLI_PREFIX_RE, ""))
  ) {
    additions.push(`--container ${container}`);
  }
  if (!container && profile && !PROFILE_FLAG_RE.test(command) && !DEV_FLAG_RE.test(command)) {
    additions.push(`--profile ${profile}`);
  }
  if (additions.length === 0) {
    return withDisplayBinaryName(command);
  }
  return withDisplayBinaryName(
    command.replace(CLI_PREFIX_RE, (match) => `${match} ${additions.join(" ")}`),
  );
}
