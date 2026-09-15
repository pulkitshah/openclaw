# Control UI webfonts

Self-hosted so the gateway can serve every face from `font-src 'self'` on a LAN
or offline install, with no third-party request. Files are unmodified upstream
subsets; `*-OFL.txt` and `LICENSE-OFL.txt` carry their licenses.

Typeface faces (`<typeface-id>.css` + its woff2) are linked on demand by
`ui/src/app/typography.ts`. The two Vasudev brand faces are linked from
`ui/index.html` before first paint instead, because the display face carries the
wordmark and page titles; only `khand-600.woff2` is preloaded.

## Vasudev brand faces (Khand, Space Mono)

Downloaded 2026-09-14 from the Google Fonts CSS API (`display=swap`), taking the
`latin` and `latin-ext` woff2 subsets of each static weight:

- Khand 400/500/600 — `https://fonts.googleapis.com/css2?family=Khand:wght@400;500;600&display=swap`,
  files under `https://fonts.gstatic.com/s/khand/v22/`.
  Upstream project and license: <https://github.com/google/fonts/tree/main/ofl/khand>.
- Space Mono 400/700 — `https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap`,
  files under `https://fonts.gstatic.com/s/spacemono/v17/`.
  Upstream project and license: <https://github.com/googlefonts/spacemono>.

The Khand `devanagari` and Space Mono `vietnamese` subsets are deliberately not
shipped: nothing in the Control UI renders those scripts in the display or mono
role, and the fallback stacks cover them.
