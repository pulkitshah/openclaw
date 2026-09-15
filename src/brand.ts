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
