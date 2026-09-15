// Product brand constants shown across CLI surfaces. Internals (CLI_NAME,
// package names, config keys, env vars, service labels, process titles, URLs,
// type names) stay `openclaw`; only user-facing prose uses these strings.
export const PRODUCT_NAME = "Vasudev";
export const MAKER_LINE = "Vasudev · by TripIn Studio";
export const TAGLINE = `All your chats, one ${PRODUCT_NAME}.`;
export const CLI_ALIASES = ["openclaw", "vasudev"] as const;
// The alias every *displayed* command and usage line spells. Both names are
// real bins, so rendered commands still run; `CLI_NAME` stays the canonical
// binary for completion registration, process titles, and argv.
export const CLI_DISPLAY_NAME = "vasudev";

/**
 * True when a name that reached us from outside — an argv[0], a `ps` command
 * line, an executable basename, a command the reader copied back — is one of
 * the published bins. `package.json` maps every `CLI_ALIASES` entry at the same
 * launcher, so a matcher that only knows `CLI_NAME` silently stops recognising
 * the same invocation typed under the displayed name. Callers normalize (case,
 * directory, `.exe`/`.cmd` suffix) to their own source's rules first; this owns
 * only the name comparison.
 */
export function isCliBinaryName(name: string | undefined | null): boolean {
  return name !== undefined && name !== null && CLI_ALIASES.some((alias) => alias === name);
}
