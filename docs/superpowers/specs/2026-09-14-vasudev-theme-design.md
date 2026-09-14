# Vasudev complete branding — theme, marks and remaining prose

Owner decision (2026-09-14): "complete branding and test before we do final push." Phase 1 (`2026-09-14-vasudev-rebrand-design.md`) renamed the visible surfaces and put the orb on the login gate and favicons. This phase makes the whole product look and read like Vasudev, per `~/.claude/commands/vasudev-brand.md`, and proves it on a hosted desk before any merge. Internals stay `openclaw` (unchanged rule).

## 1. Scope

| Area | Change | Mechanism |
| --- | --- | --- |
| Control UI tokens | Light: paper `#f7f7f9`, surface `#ffffff`, surface-2 `#f2f2f5`, sunken `#fafafb`; ink `#14151a` / `#585c66` / `#9498a2`; line `#eaeaef` / `#dfdfe6`; tint `#8a2be2`, violet-soft `#f3ebfd`, focus ring `rgba(93,51,229,.4)`. Dark: paper `#0d0e12`, surface `#16171c`, surface-2 `#1d1f26`, sunken `#131418`; ink `#f2f3f6` / `#a6aab4` / `#6b6f7a`; line `#242730` / `#31353f`; tint `#a58bf0`. Status: ok `#12a150`/`#e9f7ee`, warn `#b9820f`/`#faf1dc`, info `#3a6ff0`/`#ecf1fe`, bad `#c9302c`/`#fbe9e8` (dark softs `#122619` `#2a2210` `#111e37` `#2d1514`). Radius 18px cards / 16px panels; shadow `0 1px 2px rgba(20,21,26,.05), 0 18px 50px -14px rgba(20,21,26,.12)`; easing `cubic-bezier(.22,.68,.28,1)`. | Replace the values of the existing UI design tokens in `ui/src/styles/**` (the token names stay so components need no edits); keep every component's structure. Signature gradient `linear-gradient(95deg,#ffc24b 0%,#f97316 16%,#e0218a 38%,#8a2be2 58%,#3a6ff0 78%,#16c79a 100%)` is spent once per screen: the orb, or the wordmark's "dev". |
| Type | Khand (display: wordmark, page titles, section labels as 12px uppercase with .7px tracking, nav, crumbs), Inter/system sans body, Space Mono for ids, references, amounts, code. | Self-host Khand + Space Mono (woff2 in `ui/public/fonts`, `@font-face` in the base stylesheet, `font-display: swap`, fallback stacks Space Grotesk → system); no CDN. Startup asset budgets must still pass; fonts are lazy (`preload` only the display face). |
| Wordmark | "Vasu" in ink + "dev" filled with the gradient, Khand 600, in the login gate, sidebar header and About. | `<vasu-wordmark>` Lit element next to the existing `<vasu-orb>`. |
| Marks | Every remaining lobster/crab: About page mascot, chat empty state, `identity-avatar` default, sidebar invite ledge art, `docs/assets` hero/banner, `ui/public/app-art/**`, notification/PWA icons. | Orb SVG master + generated PNGs (existing `scripts/brand/render-orb-icons.mjs`); hero/banner = orb on paper with the wordmark; delete the lobster assets and their references; the 🦞 emoji in the CLI banner becomes the orb glyph "◉" (text) — owner may veto. |
| Voice on product surfaces | Status vocabulary from the guide where the UI already shows status: "Linked / Not linked / Needs a fix / Waiting on you / Runs alone / Ask me first"; sentence case; no exclamation marks; no emoji in product copy. Duties page and Board already follow this; apply to the channel/agent status pills and the Home banners. | English locale + the Duties UI strings; a short glossary test (forbidden words list: "AI-powered", "seamless", "autonomous agentic", "an error occurred"). |
| Remaining prose | The ~3,600 "OpenClaw" strings in `src/**` and `extensions/**` (runtime messages, doctor/update reports, system-agent inference messages, prompts, comments) and the ~150 UI test files. | The Task 4b TypeScript-aware apply extended to `src/**` and `extensions/**/src/**` (non-test source first, then tests settled from full-lane results), with the phase-1 exclusions plus: wire/protocol values (`User-Agent`, `OpenClaw/<version>` tokens), service display names that installers key on (`ai.openclaw.*` labels, Windows task names), snapshot fixtures, third-party attributions. Agent prompts are prose: they say "Vasudev". `openclaw.mjs` / `entry.version-fast-path.ts` carry the one sanctioned literal (guarded by a test against `PRODUCT_NAME`). |
| Locales | The 30 non-English UI catalogs. | The repo's i18n workflow (`ui:i18n:sync` with a translation provider); if no provider is configured on this host, the catalogs receive a mechanical name-swap only (`OpenClaw`→`Vasudev`, never other text) as an interim, flagged for a real translation run. |
| Native apps | macOS/Linux/Windows/iOS/Android display names and icons. | Deferred to a later phase (needs signing/build hosts); only the display-name constants and icon sources are updated so the next app build picks them up. |

Out of scope: layout or navigation changes (the product IA stays OpenClaw's), new components, the desktop-app IA from the guide.

## 2. Testing before the final push (the owner's requirement)

1. Repo gates on the branch: `node scripts/check-changed.mjs` full run, `pnpm tsgo:ui`, the full `src/cli` vitest lane (chunked), `ui/src` suite (chunked as Task 2 found necessary), `pnpm brand:check`, startup asset budgets, i18n verify.
2. Visual review: the Task 5 screenshot set (login, chat, About, Duties, Templates, Board, Settings, model setup) re-captured light and dark, inspected by the owner.
3. Live proof on a hosted desk: roll `vasudev-desk` to the branch tip (`roll.sh` after its stop-before-build fix), then: Control UI over the tailnet shows the theme; Telegram assistant label "Vasudev"; a Duty run end to end (amigos-search) with evidence; `openclaw --version` and doctor output on the desk say Vasudev.
4. Upstream merge dry-run: conflicts only in files the apply script rewrites plus the documented manual set.

Only after 1–4 pass does the owner get the merge/PR menu for `feat/vasudev-brand`.

## 3. Acceptance

- No "OpenClaw" visible in the Control UI (any page, light or dark), CLI output, doctor/update reports, Telegram, or docs, except the About attribution line and upstream URLs.
- The orb is the only mark; no lobster/crab asset or reference remains in `ui/`, `docs/assets`, or the CLI banner.
- Tokens, type and radius match §1; the gradient appears once per screen.
- All gates in §2 green; the desk proof recorded in `docs/superpowers/plans/2026-09-14-vasudev-theme-proof.md`.
