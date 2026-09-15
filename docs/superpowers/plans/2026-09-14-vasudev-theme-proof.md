# Vasudev complete branding — live proof (2026-09-15)

Spec: `docs/superpowers/specs/2026-09-14-vasudev-theme-design.md` §2 (testing before the final push) and §3 (acceptance).
Tree: `integration/vasudev` at `bad6f69f2c` = `main` (Duties Part 2) + `feat/hosted-desk` + `feat/vasudev-brand` + settlement lanes.

## 1. Repo gates (Mac, pnpm 12.3.4 / Node 26.8.2)

| Gate                                                                                               | Result                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                                                                | clean                                                                                                                                                                                                                 |
| `pnpm brand:check` (guard over src, extensions incl. plugin roots + manifests, packages, ui, docs) | clean                                                                                                                                                                                                                 |
| `pnpm brand:apply` twice                                                                           | idempotent                                                                                                                                                                                                            |
| `pnpm tsgo:core` / `tsgo:extensions` / `tsgo:ui`                                                   | clean                                                                                                                                                                                                                 |
| `pnpm ui:build` (startup asset budgets)                                                            | pass                                                                                                                                                                                                                  |
| `pnpm ui:i18n:verify`, `pnpm native:i18n:verify`                                                   | clean                                                                                                                                                                                                                 |
| `extensions/duties` vitest                                                                         | 308 passed                                                                                                                                                                                                            |
| `ui/src` vitest (`ui/vitest.config.ts`)                                                            | 18,218 passed, 0 failed; the runner exits 134 at teardown twice (process crash after the last test, recorded, not a test failure)                                                                                     |
| Fork CI run 2 (`34959314817`, on `03a59e4ead`)                                                     | 155 passed / 30 failed; of the 30: 6 fixed by later commits, 2 deferred by the owner (locale translations, env-var ratchet base), 22 with the round-3 fixer (10 node lanes, 1 UI shard, 12 e2e shards + real-gateway) |

## 2. Visual review (owner)

Light and dark captures from the integration build on a proof Gateway (login gate, chat, Duties, About, Settings/Appearance, Settings/Models) were sent to the owner on 2026-09-15. Fixes made from the review: the shared assistant icon draws the orb; the About hero keeps only the maker line and the upstream links live inside the Licences panel; the llama.cpp manifest line (and 42 other plugin-manifest strings) say Vasudev.

## 3. Live proof on a hosted desk

The owner chose a cutover instead of an in-place roll: a fresh droplet (`vasudev-desk-rc`, blr1, s-4vcpu-8gb) was provisioned from `integration/vasudev` by `deploy/desk/new-desk.sh`, the old desk's state, secrets, tool logins and units were streamed across over the DigitalOcean private network, the old desk's tailnet name was handed to the new one, and the old droplet was powered off behind a snapshot.

| Check                                                                      | Result                                                                                                                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning from the branch (cloud-init, runtime build, Chromium, reboot) | Gateway ready in ~10 min; UI title "Vasudev Control"                                                                                                     |
| `vasudev --version` on the desk                                            | `Vasudev 2026.9.4 (bad6f69)`                                                                                                                             |
| Control UI over the tailnet at the live name                               | answers, "Vasudev Control"                                                                                                                               |
| Telegram assistant                                                         | `@SoCynicBot` polling from the new desk                                                                                                                  |
| Gmail push                                                                 | watcher started; Funnel `:8443/gmail-pubsub` re-issued under the live name (401 unauthenticated), Pub/Sub endpoint unchanged                             |
| Logins                                                                     | Claude `loggedIn: true` (claude.ai); gog OAuth account present; Duties credential store copied                                                           |
| Duties                                                                     | 5 present (amigos-search, amigos-search-x, ask-probe, book-flight-by-mail, package-quotation)                                                            |
| Duty run `amigos-search`                                                   | run 1 failed at `open-flight-search` (browser request timed out, 45 s, right after the browser cold start); run 2 `e9f806f8…` **ok**, 26/26 steps, 200 s |

## 4. Upstream merge dry-run

Not run in this pass (deferred with the finishing-branch step for `integration/vasudev` → `main`).

## 5. Known leftovers (not user-visible in the product)

- Non-English locales carry only the product-name swap; a translation run is owed (owner deferred).
- `scripts/control-ui-mock-plugins.ts` (dev-only catalog) and three custodian-skills prose lines still say OpenClaw; chrome-extension/omarchy manifests and `OpenClaw.app`/`~/Library/Application Support/OpenClaw` are published identities (phase 3).
- `[browser/chrome] 🦞 vasudev browser started` log line keeps an emoji (operator log).
- Desk image: `x11vnc`, `xdotool` (no longer needed) and the VNC unit/password are not in cloud-init yet (machine-view plan Task 2).
