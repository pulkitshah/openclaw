# Vasudev rebrand (surface rename + orb) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user-visible "OpenClaw" reads "Vasudev" (same sentences, name swapped), the lobster marks become the Vasu orb, and a `vasudev` CLI alias exists — while every internal identifier stays `openclaw` so upstream keeps merging.

**Architecture:** One brand module per runtime (`src/brand.ts` for Node, `ui/src/app/brand.ts` for the Control UI) that the few code surfaces read; a scripted, idempotent `rebrand-apply` pass for static text (docs, manifests, templates); a `check-brand` guard that fails on any leftover user-visible "OpenClaw" while allowlisting identifiers; orb assets generated from one SVG master.

**Tech Stack:** TypeScript, Vite (`transformIndexHtml` already used in `ui/vite.config.ts`), the repo's Control UI i18n scripts (`pnpm ui:i18n:sync`, `ui:i18n:check`), Node scripts under `scripts/`, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-vasudev-rebrand-design.md`

## Global Constraints

- Work only in the worktree `/Users/pulkitshah/Developer/vasudev-openclaw-brand` on branch `feat/vasudev-brand`.
- Internals stay `openclaw`: never touch package names, `CLI_NAME`, config keys, `~/.openclaw`, plugin ids, gateway method names, `OPENCLAW_*` env vars, process titles, systemd/launchd/Bonjour service identifiers, Docker image names, URLs (`openclaw/openclaw`, `docs.openclaw.ai`), type names (`OpenClawConfig`, `OpenClawPluginApi`, …), file names (`openclaw.plugin.json`, `openclaw.mjs`).
- Product strings: name **"Vasudev"**; maker line **"Vasudev · by TripIn Studio"**; tagline **"All your chats, one Vasudev."**; Telegram assistant label **"Vasudev"**. No other wording changes.
- Locale files other than `en*.ts` are generated — never hand-edit; regenerate with the repo's i18n workflow and commit what it produces (or record that the workflow needs credentials and leave the non-English catalogs to the `control-ui-locale-refresh` workflow, marking the English source as changed).
- Gates in the FOREGROUND, one tsgo at a time: `pnpm tsgo:core`, `pnpm tsgo:ui`, `pnpm tsgo:extensions` as relevant, `node scripts/run-vitest.mjs <paths>`, `pnpm ui:i18n:check`, `pnpm exec oxfmt --write <files>`; the controller runs `node scripts/check-changed.mjs`.
- Shell prefix: `export PATH="/private/tmp/claude-501/-Users-pulkitshah-Developer-vasudev-openclaw/27667f8d-d1d5-4e9c-9ae4-83e02226504a/scratchpad/bin:$HOME/.nvm/versions/node/v26.8.2/bin:$PATH"`. Never `pnpm install`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HqBDjTY3KJDDioiMg5wXUy`.
- Docs under `docs/superpowers/**` are gitignored (`git add -f`).

---

### Task 1: Brand modules, CLI surfaces, `vasudev` alias

**Files:**

- Create: `src/brand.ts`, `src/brand.test.ts`
- Modify: `src/cli/banner.ts`, `src/cli/tagline.ts`, `src/cli/banner.test.ts`, `src/cli/tagline.test.ts`, `src/cli/program/help.ts` (only where the wordmark, not `CLI_NAME`, appears), `package.json` (`bin`)

**Interfaces:**

```ts
// src/brand.ts
export const PRODUCT_NAME = "Vasudev";
export const MAKER_LINE = "Vasudev · by TripIn Studio";
export const TAGLINE = `All your chats, one ${PRODUCT_NAME}.`;
export const CLI_ALIASES = ["openclaw", "vasudev"] as const;
```

- [ ] **Step 1: Failing tests** — `src/brand.test.ts` (constants exact); update `tagline.test.ts` `EXPECTED_DEFAULT_TAGLINE` to `"All your chats, one Vasudev."` and `banner.test.ts` expected lines to `"🦞 Vasudev 2026.3.7 (abc1234) — All your chats, one Vasudev."` (keep the lobster emoji for now — the orb has no emoji; the emoji swap is a Minor to decide in review); run → fail.
- [ ] **Step 2: Implement** — `banner.ts` uses `PRODUCT_NAME`; `tagline.ts` `DEFAULT_TAGLINE = TAGLINE` and the support line "Vasudev Support will never DM you first…" via `PRODUCT_NAME`; `package.json` `"bin": { "openclaw": "openclaw.mjs", "vasudev": "openclaw.mjs" }` (run `node scripts/check-…` for package manifest contracts if one covers `bin`; the `npm package-lock guard` lane will re-run in check-changed).
- [ ] **Step 3: Gates** (`node scripts/run-vitest.mjs src/cli src/brand.test.ts`, `pnpm tsgo:core`). Commit `feat(brand): Vasudev product name in the CLI, vasudev alias`.

---

### Task 2: Control UI name and orb favicon

**Files:**

- Create: `ui/src/app/brand.ts`, `assets/brand/orb.svg`, `ui/src/components/vasu-orb.ts` (+ test)
- Modify: `ui/index.html` (title/mount fallback copy via `transformIndexHtml` placeholders `%PRODUCT_NAME%`), `ui/public/manifest.webmanifest` (name/short_name/icons), `ui/public/favicon.svg` + `favicon-32.png` + `favicon.ico` + `apple-touch-icon.png` (regenerated from the orb), `ui/src/components/login-gate.ts` (wordmark + `<vasu-orb>`), `ui/src/components/community-invite-card.ts` (card copy uses brand), `ui/src/i18n/locales/en.ts` and `en-*.ts` (every "OpenClaw" → "Vasudev"), `ui/vite.config.ts` (`transformIndexHtml` replacement of `%PRODUCT_NAME%`/`%MAKER_LINE%`), tests: `ui/src/app/app-host.document-title.test.ts`, `app-host.test.ts`, terminal/e2e tests that assert the old copy.

**Orb SVG master (exact):**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffc24b"/><stop offset=".16" stop-color="#f97316"/><stop offset=".38" stop-color="#e0218a"/>
      <stop offset=".58" stop-color="#8a2be2"/><stop offset=".78" stop-color="#3a6ff0"/><stop offset="1" stop-color="#16c79a"/>
    </linearGradient>
    <radialGradient id="h" cx=".34" cy=".30" r=".55"><stop offset="0" stop-color="#fff" stop-opacity=".62"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <filter id="s" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>
  <circle cx="32" cy="34" r="26" fill="#8a2be2" opacity=".55" filter="url(#s)"/>
  <circle cx="32" cy="32" r="26" fill="url(#g)"/>
  <circle cx="32" cy="32" r="22" fill="url(#h)"/>
</svg>
```

`<vasu-orb size="27">` Lit element: a `div` with the CSS from `/vasudev-brand` (gradient `background-size:180% 180%`, `hue` 8 s + `breathe` 5 s animations, highlight `::after`, glow), static under `prefers-reduced-motion`.

- [ ] **Step 1: Failing tests** — `vasu-orb.test.ts` renders the element with the size attribute; document-title tests expect "Vasudev"; a new `ui/src/i18n/locales/brand.test.ts` asserts no `en*.ts` contains `\bOpenClaw\b`.
- [ ] **Step 2: Implement**; regenerate favicons: render `assets/brand/orb.svg` to PNG at 32/180/512 via the repo's existing image tooling if any (`grep -rn "sharp\|resvg\|pngjs" package.json pnpm-lock.yaml`); if none, generate with the managed browser (`node openclaw.mjs browser --browser-profile openclaw screenshot` of a data page is not available under CSP — instead commit PNGs produced by a small Playwright script using the already-installed Chromium under `node_modules/playwright-core` if present); `.ico` from the 32 px PNG via a 40-line ICO writer in `scripts/brand/make-ico.mjs` (ICO is a trivial container). Record the method.
- [ ] **Step 3: Locales** — `pnpm ui:i18n:check`; run `pnpm ui:i18n:sync` if it works offline (it may need a translation provider — if so, leave the non-English catalogs and note it in the report; the guard exempts them).
- [ ] **Step 4: Gates** (`pnpm tsgo:ui`, `node scripts/run-vitest.mjs ui/src`), commit `feat(brand): Vasudev name and orb in the Control UI`.

---

### Task 3: Channels, Bonjour, plugin descriptions, workspace templates, docs site

**Files:** `src/channels/plugins/pairing-message.ts` (+test), `extensions/telegram/src/bot-message-context.session.ts` (`senderLabels.assistant: PRODUCT_NAME` — import via a plugin-sdk-safe path: if `src/brand.ts` is not exported through `openclaw/plugin-sdk/*`, add a `openclaw/plugin-sdk/brand` subpath following `docs/plugins/sdk-entrypoints.md` and `scripts/lib/plugin-sdk-entrypoints.json`), `extensions/bonjour/src/advertiser.ts` (+test), `extensions/*/openclaw.plugin.json` descriptions (scripted), `docs/reference/AGENTS.default.md` + `docs/reference/templates/*.md`, `docs/docs.json` (`name: "Vasudev"`, `logo`/`favicon` → `/assets/orb.svg`, `colors.primary: "#8a2be2"`), `docs/assets/orb.svg`, `README.md`.

- [ ] Failing tests for pairing message and Bonjour name; implement; run the plugin-sdk entrypoint contract tests if a subpath was added (`node scripts/run-vitest.mjs src/plugin-sdk`), `pnpm tsgo:extensions`; commit `feat(brand): Vasudev in channel copy, Bonjour, plugin descriptions, templates and docs site`.

---

### Task 4: Guard and apply scripts

**Files:** `scripts/rebrand-apply.mjs`, `scripts/check-brand.mjs`, `scripts/check-brand.test.ts`, `scripts/check-changed.mjs` (add a `brand guard` lane for changed files under the allowlist), `package.json` scripts `brand:apply`, `brand:check`.

**Contract:**

- Allowlist globs (user-visible): `ui/src/**/*.ts` (excluding `*.test.ts`? no — tests included), `ui/index.html`, `ui/public/manifest.webmanifest`, `src/cli/**/*.ts`, `src/wizard/**/*.ts`, `src/flows/**/*.ts`, `src/channels/plugins/pairing-message.ts`, `extensions/*/openclaw.plugin.json`, `extensions/telegram/src/bot-message-context.session.ts`, `extensions/bonjour/src/advertiser.ts`, `docs/**/*.md`, `README.md`, `docs/docs.json`.
- Identifier exclusions (regex, never rewritten): `OpenClaw[A-Z][A-Za-z]*` (types), `openclaw(?=[./_-])` and `\bopenclaw\b` (lowercase identifiers/commands), `OPENCLAW_`, URLs containing `openclaw`, `ai.openclaw`, `_openclaw-gw`, `~/.openclaw`, code fences in Markdown (` ```…``` ` and inline backticks) — prose only is rewritten.
- `rebrand-apply.mjs`: rewrites `\bOpenClaw\b` → `Vasudev` outside the exclusions; prints a per-file change count; `--check` mode exits 1 with the offending lines (this is what `check-brand.mjs` runs).
- Test fixtures: a Markdown file with prose + a code fence + a type name → only the prose changes; a locale file line `brandName: "OpenClaw"` → rewritten; `docs.openclaw.ai` untouched.

- [ ] Failing tests → implement → run `pnpm brand:apply` over the repo (this performs the docs prose pass in one commit: `chore(brand): apply the Vasudev name across docs`) → `pnpm brand:check` clean → commit the scripts `feat(brand): rebrand apply + guard scripts`.

---

### Task 5: Proof

- [ ] Build the fork (`pnpm build`, foreground) in the worktree; `node openclaw.mjs --version` and the banner show Vasudev; `node openclaw.mjs --help` header; run the Control UI dev server or the built dashboard on a spare port (`node openclaw.mjs gateway run --port 19002` with a throwaway state dir `~/.openclaw-brand-proof` and no channels) and capture screenshots (login gate with the orb, chat page "Ask Vasudev", tab title) with the managed browser; verify `pnpm brand:check` is clean and that `git merge --no-commit upstream/main` (dry run, then abort) conflicts only inside the allowlist. Write `docs/superpowers/plans/2026-09-14-vasudev-rebrand-proof.md` (`git add -f`), stop the proof Gateway (kill by port owner), commit `docs(brand): rebrand proof`.

---

## Self-review

Spec §1 rows → T1 (CLI, bin), T2 (UI, favicon), T3 (channels, Bonjour, manifests, templates, docs site), T4 (docs prose pass + guard), native apps deferred (phase 3, out of this plan). §2 mechanism → T1/T2 brand modules, T4 scripts, T2 orb. §4 acceptance → T5. Placeholders: none (`%PRODUCT_NAME%` is a Vite HTML placeholder by design). Type consistency: `PRODUCT_NAME`/`MAKER_LINE`/`TAGLINE`/`CLI_ALIASES` identical across T1–T3.
