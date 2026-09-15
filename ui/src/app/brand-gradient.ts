/** The signature gradient, in one place for the Control UI.
 *
 * `--brand-gradient` in `ui/src/styles/base.css` is the token components paint
 * with; this literal is the fallback they carry so the mark still renders if the
 * base stylesheet has not applied. The brand guide spends the gradient once per
 * screen, so `<vasu-orb>` and `<vasu-wordmark>` are its only consumers — and
 * when they sit together the wordmark gives it up and renders in ink. Keep this
 * value and the token in step. `assets/brand/orb.svg` carries the same stops for
 * the rasterized masters, which render outside the CSS cascade. */
export const SIGNATURE_GRADIENT =
  "linear-gradient(95deg, #ffc24b 0%, #f97316 16%, #e0218a 38%, #8a2be2 58%, #3a6ff0 78%, #16c79a 100%)";
