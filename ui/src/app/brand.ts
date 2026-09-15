/** Product-facing brand strings for the Control UI.
 *
 * One owner for the name the user reads. Internal identifiers — element names,
 * storage keys, CSS class stems, gateway methods — stay `openclaw` and must not
 * be derived from these values. `ui/vite.config.ts` also imports this module to
 * stamp the `index.html` placeholders, so it must stay dependency-free. */
export const PRODUCT_NAME = "Vasudev";
export const MAKER_LINE = "Vasudev · by TripIn Studio";
export const TAGLINE = "All your chats, one Vasudev.";

/** The binary name shown in a command the reader is meant to copy and run.
 *
 * Both `openclaw` and `vasudev` are installed bins, so a shown command works
 * either way; the reader sees the product they installed. Never use this for a
 * command the code itself spawns, compares or persists. */
export const CLI_NAME = "vasudev";

/** Which optional product surfaces this build ships.
 *
 * `lobsterDex` covers the decorative sidebar pet, its appearance-settings
 * section and the `/lobsterdex` page. It is Vasudev's mascot feature, so the
 * Vasudev build ships with it off; the code, sprites and locale strings stay in
 * place, and turning the flag back on restores all three surfaces. */
export const FEATURES: { lobsterDex: boolean } = { lobsterDex: false };
