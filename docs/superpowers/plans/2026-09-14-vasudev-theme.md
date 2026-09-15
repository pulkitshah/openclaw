# Vasudev Complete Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the whole product look and read like Vasudev (theme, marks, voice, remaining prose) and prove it on a hosted desk before any merge.

**Architecture:** Token-value swap in the existing UI design system (names unchanged), two small Lit elements (`<vasu-orb>` exists, add `<vasu-wordmark>`), asset replacement driven by the orb SVG master, and the phase-1 TypeScript-aware apply script extended to the whole source tree with a wider exclusion list. Proof = repo gates + light/dark screenshot set + a desk rolled to an integration branch.

**Tech Stack:** Lit + Vite Control UI, self-hosted woff2 fonts, `scripts/rebrand-apply.mjs` (Node, TypeScript compiler API), vitest, `deploy/desk/roll.sh`.

**Spec:** `docs/superpowers/specs/2026-09-14-vasudev-theme-design.md` (this plan argues from it; phase-1 spec `2026-09-14-vasudev-rebrand-design.md` still binds: internals stay `openclaw`).

## Global Constraints

- Internals stay `openclaw`: package names, binary, config keys, `~/.openclaw`, env vars, service labels/types, plugin ids, gateway method names, URLs, type names. Only prose and marks change.
- Token NAMES in `ui/src/styles/**` do not change; only values. No layout, navigation or component-structure changes.
- Gradient `linear-gradient(95deg,#ffc24b 0%,#f97316 16%,#e0218a 38%,#8a2be2 58%,#3a6ff0 78%,#16c79a 100%)` appears at most once per screen (orb or wordmark "dev").
- Fonts self-hosted under `ui/public/fonts/` with `font-display: swap`; no CDN; startup asset budgets (`pnpm ui:build` reports) must pass; preload only the display face.
- No "OpenClaw" visible on any product surface except the About attribution line and upstream URLs (spec §3).
- Exclusions for the prose apply, verbatim: `OpenClaw[A-Z]\w*` identifiers; lowercase `openclaw`; `OPENCLAW_*`; URLs; `~/.openclaw`; `ai.openclaw.*`; `_openclaw-gw`; `OpenClaw/` wire tokens (User-Agent style); installer/service display labels and Windows task names; snapshot fixtures; third-party attributions; code fences in Markdown; `CHANGELOG.md`; `docs/superpowers/**`; generated blocks by marker; bundle/artifact names (`OpenClaw.app`, `.dmg`, `.exe`, `.msi`, `.pkg`, `.zip`).
- Every implementer runs commands in the FOREGROUND only; commits by pathspec (shared worktree); usual trailers.
- Tests are settled from real lane results: an expectation changes only when the string it pins came from a file the apply rewrote; otherwise it keeps the original text.

---

### Task 1: Theme tokens and type

**Files:**
- Modify: the token stylesheet(s) under `ui/src/styles/` that define the palette, radius, shadow and motion variables (find with `rg -n "--color|--radius|--shadow|--ease|--font" ui/src/styles | head`), light and dark blocks.
- Create: `ui/public/fonts/khand-{400,500,600}.woff2`, `ui/public/fonts/space-mono-{400,700}.woff2` (Google Fonts, OFL; download the woff2 files; record the source URLs and licence file `ui/public/fonts/LICENSE-OFL.txt`).
- Modify: the base/global stylesheet that declares fonts (add `@font-face` for Khand and Space Mono; body stays Inter/system).
- Modify: `ui/index.html` (preload the Khand 600 face only).
- Test: `ui/src/styles/theme-tokens.test.ts` (new): parses the token stylesheet and asserts the light and dark values from spec §1 for paper, surface, ink, line, tint, ok/warn/info/bad, radius, shadow, easing; asserts every token name that existed before still exists (snapshot the name list from `git show HEAD:<file>`).

**Interfaces:** Produces the token values consumed by every component; produces `--font-display: "Khand", "Space Grotesk", system-ui, sans-serif`, `--font-mono: "Space Mono", ui-monospace, monospace`.

- [ ] Step 1: Write `theme-tokens.test.ts` asserting the spec values (fails on the current values).
- [ ] Step 2: Swap the values (light block, dark block, status tints, radius, shadow, easing) — names untouched.
- [ ] Step 3: Add the fonts, `@font-face`, and the preload; set page titles, section labels (12px uppercase, .7px tracking), nav and crumbs to `--font-display`; ids/amounts/code to `--font-mono` (only where a mono/heading role already exists in the CSS — no new classes).
- [ ] Step 4: `pnpm tsgo:ui`; `node scripts/run-vitest.mjs ui/src/styles`; `pnpm ui:build` (budgets pass); capture light and dark screenshots of login, chat, Duties, Settings with playwright-core into `docs/superpowers/plans/assets/2026-09-14-vasudev-theme/` (`git add -f`).
- [ ] Step 5: Commit `feat(brand): Vasudev theme tokens and type`.

### Task 2: Wordmark and marks

**Files:**
- Create: `ui/src/components/vasu-wordmark.ts` (+ test) — "Vasu" in ink, "dev" with the gradient via `background-clip: text`, Khand 600; sizes `sm|md|lg`; `aria-label="Vasudev"`.
- Modify: login gate, sidebar header, About page to use `<vasu-wordmark>` beside `<vasu-orb>`.
- Replace: About mascot, chat empty-state art, `identity-avatar` default (`mascot.svg`), invite-ledge art (`lobster-invite-ledge-*.png`), `ui/public/app-art/**` lobster files, `docs/assets/pixel-lobster.svg`, `docs/assets/openclaw-hero-*.png`, `docs/assets/openclaw-banner-*.png` → orb renders (extend `scripts/brand/render-orb-icons.mjs` with hero/banner compositions: orb + wordmark on paper `#f7f7f9`, sizes matching the replaced files).
- Delete: every lobster/crab asset and its references (`rg -il "lobster|crab|mascot" ui docs/assets src/cli`).
- Modify: `src/cli/banner.ts` — the 🦞 emoji becomes "◉" (text glyph) with a test update; keep the layout.
- Modify: `docs/docs.json` logo/favicon to the orb, colours `primary #8a2be2`, `light #a58bf0`, `dark #8a2be2`.
- Test: `ui/src/components/vasu-wordmark.test.ts`; a repo test `test/brand/no-lobster-assets.test.ts` that fails if any file matching `/lobster|crab|mascot\.svg/i` exists under `ui/`, `docs/assets/`, or is referenced from `ui/src`, `src/cli`.

- [ ] Step 1: Failing tests (wordmark renders both spans with the gradient class; no-lobster scan fails today).
- [ ] Step 2: Implement the wordmark; wire it into the three places.
- [ ] Step 3: Generate the orb compositions; replace and delete assets; update references; docs.json.
- [ ] Step 4: `pnpm tsgo:ui`; `node scripts/run-vitest.mjs ui/src/components test/brand`; `pnpm ui:build`; `node scripts/run-vitest.mjs src/cli/banner.test.ts`.
- [ ] Step 5: Commit `feat(brand): Vasu wordmark; orb replaces every remaining mark`.

### Task 3: Voice on product surfaces

**Files:**
- Modify: `ui/src/i18n/locales/en.ts` and the Duties/Board UI strings — status pills and banners use "Linked / Not linked / Needs a fix / Waiting on you / Runs alone / Ask me first"; sentence case; remove exclamation marks and emoji from product copy.
- Test: `ui/src/i18n/locales/voice.test.ts` — forbidden phrases (`AI-powered`, `seamless`, `autonomous agentic`, `An error occurred`, `Pending user input required`) absent from `en.ts`; no `!` at the end of a UI string; no emoji code points in `en.ts` values (allowlist the identity emoji picker strings).

- [ ] Step 1: Failing voice test. - [ ] Step 2: Edit the strings. - [ ] Step 3: `pnpm ui:i18n:verify` (baseline if required), `node scripts/run-vitest.mjs ui/src/i18n`. - [ ] Step 4: Commit `feat(brand): Vasudev voice on status pills and banners`.

### Task 4: Remaining prose everywhere

**Files:**
- Modify: `scripts/rebrand-apply.mjs`, `scripts/check-brand.mjs`, `test/scripts/check-brand.test.ts` — allowlist becomes `src/**/*.ts(x)`, `extensions/**/src/**/*.ts(x)`, `ui/src/**/*.ts` (tests included in the guard, excluded from the apply), `packages/**/src/**`; add the exclusions from Global Constraints (wire tokens, installer labels, Windows task names, attributions) as tested rules; a `--only <glob>` flag for chunked runs.
- Modify: `openclaw.mjs:435` and `src/entry.version-fast-path.ts:58` — the literal "Vasudev" (sanctioned exception) + `test/brand/version-fast-path.test.ts` asserting the literal equals `PRODUCT_NAME`.
- Modify: `src/system-agent/inference-fallback.ts`, `src/gateway/server-methods/system-agent.ts` and siblings via the apply (user-facing inference messages).
- Modify: the 30 non-English `ui/src/i18n/locales/*.ts` — mechanical `OpenClaw`→`Vasudev` only (a `--locales` mode that touches nothing else), `ui:i18n:verify` + baseline; flagged for a real translation run in the report.
- Apply order (each its own commit, each followed by its lanes): (a) `src/system-agent`, `src/gateway`, `src/commands`, `src/infra`, `src/daemon`, `src/state`, `src/config`, `src/agents`, `src/plugins`, `src/auto-reply`, `src/cron`, `src/talk`, `src/meeting-bot`, `src/plugin-sdk`, remaining `src/**`; (b) `extensions/**/src`; (c) `ui/src` test files; (d) locales. Lanes: `pnpm tsgo:core`, `pnpm tsgo:extensions`, `pnpm tsgo:ui`, `node scripts/run-vitest.mjs <dir>` per touched top-level dir (chunked), full `src/cli` lane chunked, `ui/src` chunked.
- Test settlements per Global Constraints; record every reverted expectation in the report table.

- [ ] Step 1: Extend the script + tests (failing first: wire token untouched, installer label untouched, `--only` works). - [ ] Step 2: Version fast-path exception + test. - [ ] Step 3: Apply in the order above, lane by lane, settling tests. - [ ] Step 4: `pnpm brand:check` clean across the whole allowlist; `node scripts/check-changed.mjs`. - [ ] Step 5: Commits as listed.

### Task 5: Native app names and icon sources

**Files:** macOS `apps/macos/**/Info.plist` display names, Linux Tauri `productName`, Windows Companion product name strings, iOS/Android display names; icon SOURCE files replaced by the orb renders (no app builds; bundle ids unchanged). Test: a scan test that the display-name constants say Vasudev.

- [ ] Step 1: Failing scan test. - [ ] Step 2: Edit names, replace icon sources. - [ ] Step 3: Commit `feat(brand): Vasudev display names and icon sources for the native apps`.

### Task 6: Test and prove before the push

**Files:** `docs/superpowers/plans/2026-09-14-vasudev-theme-proof.md` (+ screenshots), `deploy/desk/roll.sh` (in the desk branch: stop the Gateway before the build, print "updating", start after), an integration branch `integration/vasudev` = `main` + `feat/hosted-desk` + `feat/vasudev-brand`.

- [ ] Step 1: In `/Users/pulkitshah/Developer/vasudev-openclaw-desk`, fix `roll.sh` (stop before build; runbook line) with a test; commit; push.
- [ ] Step 2: Create `integration/vasudev` from `main`, merge `feat/hosted-desk` then `feat/vasudev-brand` (resolve the documented conflicts: config baseline sha, surface-report budgets, `ui/**`); push.
- [ ] Step 3: Gates on the integration branch: `node scripts/check-changed.mjs`, `pnpm tsgo:ui`, chunked `src/cli` + `ui/src` lanes, `pnpm brand:check`, `pnpm ui:build` budgets, `pnpm ui:i18n:verify`.
- [ ] Step 4: Screenshot set light + dark (login, chat, About, Duties, Templates, Board, Settings, model setup) → owner review.
- [ ] Step 5: `deploy/desk/roll.sh vasudev-desk --git-ref integration/vasudev`; prove on the desk: Control UI theme over the tailnet, `openclaw --version`, doctor output, Telegram label, `amigos-search` run with evidence.
- [ ] Step 6: Upstream merge dry-run classification; write the proof; commit; present the merge/PR menu.
