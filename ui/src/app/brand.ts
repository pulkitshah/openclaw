/** Product-facing brand strings for the Control UI.
 *
 * One owner for the name the user reads. Internal identifiers — element names,
 * storage keys, CSS class stems, gateway methods — stay `openclaw` and must not
 * be derived from these values. `ui/vite.config.ts` also imports this module to
 * stamp the `index.html` placeholders, so it must stay dependency-free. */
export const PRODUCT_NAME = "Vasudev";
export const MAKER_LINE = "Vasudev · by TripIn Studio";
export const TAGLINE = "All your chats, one Vasudev.";
