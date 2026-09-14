# Hosted desk (Linux) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A DigitalOcean Ubuntu VM ("desk") that runs this fork's Gateway + Duties with a headed Chromium on Xvfb, reachable only over the owner's tailnet, created and updated by scripts, proven by running `book-flight-by-mail` on it.

**Architecture:** `deploy/desk/` holds `new-desk.sh` (doctl + cloud-init), `roll.sh` (update in place), the units and policy files, and the runbook. The plugin gains a Linux credential backend (AES-256-GCM file keyed by a root-owned keyfile), a `maxParallelRuns` setting read at run start, a `duties.desk.status` method fed by a health file written by a systemd timer, and a Desk health strip in the UI. No new dependencies.

**Tech Stack:** bash + cloud-init + systemd, `doctl`, Tailscale (`--ssh`, Serve), Node 26, TypeScript plugin code under `extensions/duties`, vitest, shellcheck.

**Spec:** `docs/superpowers/specs/2026-09-14-hosted-desk-design.md`

## Global Constraints

- Work happens in the worktree `/Users/pulkitshah/Developer/vasudev-openclaw-desk` on branch `feat/hosted-desk` (never in the main checkout, which runs the live proof Gateway).
- Plugin code: only `openclaw/plugin-sdk/*` + node builtins + typebox imports; `// SAFETY:` above every non-const `as`; `isRecord` from `openclaw/plugin-sdk/string-coerce-runtime`; no new npm dependencies.
- Secrets never in the repo, logs, or cloud-init logs: auth keys and tokens are passed as files at create time and written with `permissions: '0600'`; the Tailscale auth key file is deleted after `tailscale up`.
- Scripts: `set -euo pipefail`, `shellcheck`-clean, idempotent where re-run is plausible; every failure prints the next action.
- Tests: TDD (failing test first); gates in the FOREGROUND, never concurrently with another tsgo/check-changed: `node scripts/run-vitest.mjs extensions/duties`, `pnpm tsgo:extensions`, `node --import ./scripts/tsx.mjs scripts/check-assertion-safety-ratchet.mts --base origin/main`, `pnpm exec oxfmt --write <changed files>`, `shellcheck deploy/desk/*.sh`. The controller runs `node scripts/check-changed.mjs`.
- Shell prefix for every command: `export PATH="/private/tmp/claude-501/-Users-pulkitshah-Developer-vasudev-openclaw/27667f8d-d1d5-4e9c-9ae4-83e02226504a/scratchpad/bin:$HOME/.nvm/versions/node/v26.8.2/bin:$PATH"`. Never `pnpm install`.
- Commit messages: Conventional Commits ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HqBDjTY3KJDDioiMg5wXUy`.
- Docs under `docs/superpowers/**` are gitignored: `git add -f`; no personal paths/hostnames in `docs/` (the runbook uses `<desk-name>`, `<tailnet>`).
- The live proof (Task 6) is the only task that touches DigitalOcean; it never touches the owner's Mac Gateways or `~/.openclaw*`.

---

## File structure

| File                                                                  | Responsibility                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `extensions/duties/src/creds.ts` (modify) + `creds-linux.ts` (create) | Linux backend: encrypted file store selected on `linux`                    |
| `extensions/duties/src/store.ts` (modify)                             | `DutiesSettings.maxParallelRuns`                                           |
| `extensions/duties/src/run-service.ts` (modify)                       | reads the parallel limit at `start()` via a `limit()` callback             |
| `extensions/duties/src/desk.ts` (create)                              | `readDeskHealth(path)` + `deskStatus()` shape                              |
| `extensions/duties/src/gateway-methods.ts` (modify)                   | `duties.desk.status`; `duties.settings.set { maxParallelRuns }` validation |
| `extensions/duties/src/cli.ts` (modify)                               | `openclaw duties setup` prints desk prerequisites when hosted              |
| `extensions/duties/browser/render.ts`, `browser/index.ts` (modify)    | Desk health strip + parallel-runs input                                    |
| `deploy/desk/cloud-init.yaml.tmpl`, `units/*.service                  | timer`, `chromium-policy.json`, `desk-health.sh`, `render-cloud-init.mjs`  | the desk image |
| `deploy/desk/new-desk.sh`, `roll.sh`, `snapshot.sh`, `README.md`      | operator scripts + runbook                                                 |
| `docs/hosted-desk.md`                                                 | user docs                                                                  |

---

### Task 1: Linux credential backend

**Files:**

- Create: `extensions/duties/src/creds-linux.ts`
- Modify: `extensions/duties/src/creds.ts` (dispatch on `platform === "linux"`)
- Test: `extensions/duties/src/creds-linux.test.ts`

**Interfaces:**

- Consumes: `CRED_KEY_RE`/`assertKey` semantics from `creds.ts` (keys `^[a-z0-9][a-z0-9_.-]{0,63}$`).
- Produces:

  ```ts
  export type LinuxCredStore = {
    get(key): Promise<string>;
    set(key, value): Promise<void>;
    delete(key): Promise<boolean>;
    has(key): Promise<boolean>;
  };
  export function createLinuxCredStore(opts?: {
    storePath?: string;
    keyfilePath?: string;
  }): LinuxCredStore;
  // defaults: storePath = path.join(os.homedir(), ".openclaw", "plugins", "duties", "creds.enc"); keyfilePath = process.env.DUTIES_CRED_KEYFILE ?? "/etc/openclaw/keyfile"
  ```

  `creds.ts`: `credGet/credSet/credDelete/credHas` call the Linux store when `platform === "linux"` (store instance memoized per process; tests inject paths via a module-level `setLinuxCredStoreForTests`).

- [ ] **Step 1: Failing tests**

```ts
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLinuxCredStore } from "./creds-linux.js";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "duties-creds-"));
  const keyfilePath = path.join(dir, "keyfile");
  await writeFile(keyfilePath, randomBytes(32), { mode: 0o600 });
  return { dir, keyfilePath, storePath: path.join(dir, "creds.enc") };
}

describe("createLinuxCredStore", () => {
  it("round-trips values, lists presence, and deletes", async () => {
    const f = await fixture();
    const store = createLinuxCredStore(f);
    await store.set("amigos.password", "p@ss\nwith newline");
    expect(await store.get("amigos.password")).toBe("p@ss\nwith newline");
    expect(await store.has("amigos.password")).toBe(true);
    expect(await store.has("nope")).toBe(false);
    expect(await store.delete("amigos.password")).toBe(true);
    await expect(store.get("amigos.password")).rejects.toThrow(
      /no credential stored for amigos\.password/u,
    );
  });
  it("never writes the value in clear and detects tampering", async () => {
    const f = await fixture();
    const store = createLinuxCredStore(f);
    await store.set("k", "SECRET-VALUE");
    const raw = await readFile(f.storePath);
    expect(raw.includes("SECRET-VALUE")).toBe(false);
    raw[raw.length - 1] ^= 0xff;
    await writeFile(f.storePath, raw);
    await expect(store.get("k")).rejects.toThrow(
      /credential store is corrupt or was written with another keyfile/u,
    );
  });
  it("names the missing keyfile", async () => {
    const f = await fixture();
    const store = createLinuxCredStore({
      storePath: f.storePath,
      keyfilePath: path.join(f.dir, "missing"),
    });
    await expect(store.set("k", "v")).rejects.toThrow(
      /no credential keyfile at .*missing — create it as root with 32 random bytes, readable by the service user/u,
    );
  });
  it("serializes concurrent writes", async () => {
    const f = await fixture();
    const store = createLinuxCredStore(f);
    await Promise.all(["a", "b", "c", "d"].map((k) => store.set(k, `v-${k}`)));
    for (const k of ["a", "b", "c", "d"]) expect(await store.get(k)).toBe(`v-${k}`);
  });
});
```

- [ ] **Step 2: Run → fail** (`node scripts/run-vitest.mjs extensions/duties/src/creds-linux.test.ts`).

- [ ] **Step 3: Implement `creds-linux.ts`**

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const MAGIC = "OCDC1"; // openclaw duties creds, format 1
const IV_BYTES = 12;

export type LinuxCredStore = {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
};

/** Servers have no keychain, so values live in one AES-256-GCM blob keyed by a root-owned keyfile
 *  the service user can read but not write (Vasudev's hosted-desk model). Every write re-encrypts
 *  the whole map with a fresh IV and lands via rename, so a crash never leaves a half-written store. */
export function createLinuxCredStore(opts?: {
  storePath?: string;
  keyfilePath?: string;
}): LinuxCredStore {
  const storePath =
    opts?.storePath ?? path.join(os.homedir(), ".openclaw", "plugins", "duties", "creds.enc");
  const keyfilePath =
    opts?.keyfilePath ?? process.env.DUTIES_CRED_KEYFILE ?? "/etc/openclaw/keyfile";
  let chain: Promise<void> = Promise.resolve();

  const deriveKey = async (): Promise<Buffer> => {
    let raw: Buffer;
    try {
      raw = await readFile(keyfilePath);
    } catch {
      throw new Error(
        `no credential keyfile at ${keyfilePath} — create it as root with 32 random bytes, readable by the service user`,
      );
    }
    if (raw.length < 16)
      throw new Error(`credential keyfile at ${keyfilePath} is too short (need 32 random bytes)`);
    return Buffer.from(hkdfSync("sha256", raw, "", "openclaw-duties-creds", 32));
  };

  const readMap = async (): Promise<Record<string, string>> => {
    let blob: Buffer;
    try {
      blob = await readFile(storePath);
    } catch {
      return {};
    }
    const key = await deriveKey();
    const magic = blob.subarray(0, MAGIC.length).toString();
    if (magic !== MAGIC || blob.length < MAGIC.length + IV_BYTES + 16) {
      throw new Error("credential store is corrupt or was written with another keyfile");
    }
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = blob.subarray(blob.length - 16);
    const data = blob.subarray(MAGIC.length + IV_BYTES, blob.length - 16);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      const parsed: unknown = JSON.parse(json);
      // SAFETY: the store only ever writes Record<string,string>; anything else fails the auth tag first.
      return parsed as Record<string, string>;
    } catch {
      throw new Error("credential store is corrupt or was written with another keyfile");
    }
  };

  const writeMap = async (map: Record<string, string>): Promise<void> => {
    const key = await deriveKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(map), "utf8")),
      cipher.final(),
    ]);
    const blob = Buffer.concat([Buffer.from(MAGIC), iv, data, cipher.getAuthTag()]);
    await mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, blob, { mode: 0o600 });
    await rename(tmp, storePath);
  };

  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const assertKey = (key: string) => {
    if (!KEY_RE.test(key)) throw new Error("invalid credential key");
  };

  return {
    async get(key) {
      assertKey(key);
      const map = await readMap();
      if (!Object.hasOwn(map, key)) throw new Error(`no credential stored for ${key}`);
      return map[key] ?? "";
    },
    set(key, value) {
      assertKey(key);
      if (!value) throw new Error("credential value is empty");
      return locked(async () => {
        const map = await readMap();
        map[key] = value;
        await writeMap(map);
      });
    },
    delete(key) {
      assertKey(key);
      return locked(async () => {
        const map = await readMap();
        if (!Object.hasOwn(map, key)) return false;
        delete map[key];
        await writeMap(map);
        return true;
      });
    },
    async has(key) {
      assertKey(key);
      return Object.hasOwn(await readMap(), key);
    },
  };
}
```

`creds.ts`: add `import { createLinuxCredStore, type LinuxCredStore } from "./creds-linux.js";`, a module-level `let linuxStore: LinuxCredStore | undefined;` with `export function setLinuxCredStoreForTests(store?: LinuxCredStore)`, `const linux = () => (linuxStore ??= createLinuxCredStore());` and at the top of each of `credGet/credSet/credDelete/credHas`: `if (platform === "linux") return linux().<op>(...)` (matching return types). Extend `creds.test.ts` with one test per op using an injected store.

- [ ] **Step 4: Tests → pass. Gates. Commit:** `feat(duties): linux credential store for hosted desks`.

---

### Task 2: Parallel-run limit, desk health, and the Desk strip

**Files:**

- Modify: `extensions/duties/src/store.ts`, `src/run-service.ts`, `src/gateway-methods.ts`, `src/cli.ts`, `index.ts`, `browser/render.ts`, `browser/index.ts`, `openclaw.plugin.json` (UI hash)
- Create: `extensions/duties/src/desk.ts`
- Test: `run-service.test.ts`, `gateway-methods.test.ts`, `desk.test.ts`, `render.test.ts`, `cli.test.ts`

**Interfaces:**

- `DutiesSettings.maxParallelRuns?: number` (1–8; default 4).
- `RunManager` constructor param `maxParallel?: number | (() => Promise<number> | number)`; `canStart` awaits the current value (make `pump()` async-safe: compute the limit once per pump).
- `desk.ts`:
  ```ts
  export type DeskHealth = {
    hosted: boolean;
    at?: number;
    gateway?: boolean;
    display?: boolean;
    chromium?: boolean;
    tailscale?: boolean;
    mailWatcher?: boolean;
    load1?: number;
    memFreeMb?: number;
  };
  export const DESK_HEALTH_PATH =
    process.env.DUTIES_DESK_HEALTH ?? "/var/lib/openclaw/desk-health.json";
  export async function readDeskHealth(filePath = DESK_HEALTH_PATH): Promise<DeskHealth>; // { hosted:false } when absent/unparseable
  ```
- Gateway: `duties.desk.status` (operator.read) → `DeskHealth & { maxParallelRuns, active, queued }`; `duties.settings.set` accepts `maxParallelRuns` (integer 1–8 else error `maxParallelRuns must be a whole number from 1 to 8`).
- CLI: `openclaw duties setup` adds a "Desk" block when `hosted: true` (keyfile present? display? allowedHostnames?).
- UI: settings strip → **Desk** card (chips + number input `data-parallel-save`), hidden when `hosted: false` except the parallel input.

- [ ] **Step 1: Failing tests** — `run-service.test.ts`: with `maxParallel: async () => 1`, two starts → second `queued` with `"waiting for a free slot"`; raising the limit to 2 (a mutable stub) and starting a third → runs. `desk.test.ts`: missing file → `{ hosted:false }`; a JSON file → parsed with `hosted:true`; malformed → `{ hosted:false }`. `gateway-methods.test.ts`: `duties.desk.status` merges limit/active/queued; `duties.settings.set { maxParallelRuns: 9 }` rejected, `{ maxParallelRuns: 3 }` stored. `render.test.ts`: desk card shows chips and the input; hidden chips when not hosted. `cli.test.ts`: setup output contains "Desk" lines when hosted.
- [ ] **Step 2: Run → fail. Step 3: implement.** `index.ts`: `new RunManager({ ..., maxParallel: async () => (await store.getSettings()).maxParallelRuns ?? 4 })`; register the method; `duties.settings.set` validation; UI wiring (`loadDeskStatus` on the board alongside mail status; `saveParallel` handler). Rebuild the UI bundle and include the manifest hash.
- [ ] **Step 4: Tests → pass. Gates. Commit:** `feat(duties): desk health, parallel-run limit setting`.

---

### Task 3: Desk image — cloud-init, units, policy, health timer

**Files:**

- Create: `deploy/desk/cloud-init.yaml.tmpl`, `deploy/desk/render-cloud-init.mjs`, `deploy/desk/units/xvfb.service`, `deploy/desk/units/openclaw-gateway.service`, `deploy/desk/units/desk-health.service`, `deploy/desk/units/desk-health.timer`, `deploy/desk/chromium-policy.json`, `deploy/desk/desk-health.sh`, `deploy/desk/openclaw.json.tmpl`
- Test: `deploy/desk/render-cloud-init.test.ts` (vitest, run with `node scripts/run-vitest.mjs deploy/desk`) — renders with fixture inputs, asserts no placeholder remains, secrets are only inside `write_files` entries with `permissions: '0600'`, and the YAML parses (use `js-yaml` if present in node_modules — check `ls node_modules/js-yaml`; else a minimal structural check).

**Contents (exact):**

`units/xvfb.service`

```ini
[Unit]
Description=Virtual display for the OpenClaw desk
After=network.target
[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
```

`units/openclaw-gateway.service`

```ini
[Unit]
Description=OpenClaw Gateway (desk)
After=network-online.target xvfb.service tailscaled.service
Wants=network-online.target xvfb.service
[Service]
User=openclaw
Group=openclaw
WorkingDirectory=/opt/openclaw
Environment=DISPLAY=:99
Environment=OPENCLAW_BROWSER_HEADLESS=0
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/openclaw/openclaw.mjs gateway run
Restart=always
RestartSec=3
# The Gateway drains active work on SIGTERM and can wait on a live agent session forever; give it
# 45 s, then SIGKILL the whole group (KillMode=mixed) — the lesson from the Part 2 proof.
TimeoutStopSec=45
KillMode=mixed
OOMScoreAdjust=-500
[Install]
WantedBy=multi-user.target
```

`units/desk-health.service` + `.timer` (every 2 min, `OnBootSec=1min`), running `/opt/openclaw/deploy/desk/desk-health.sh` as root.

`desk-health.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
OUT=/var/lib/openclaw/desk-health.json
mkdir -p "$(dirname "$OUT")"
ok() { [ "$1" = 0 ] && echo true || echo false; }
gw=$(systemctl is-active --quiet openclaw-gateway; echo $?)
disp=$(DISPLAY=:99 xdpyinfo >/dev/null 2>&1; echo $?)
[ "$disp" != 0 ] && systemctl restart xvfb
chrome=$(pgrep -u openclaw -f "chrom(e|ium)" >/dev/null 2>&1; echo $?)
ts=$(tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; echo $?)
mail=$(pgrep -f "gog gmail watch serve" >/dev/null 2>&1; echo $?)
load1=$(cut -d' ' -f1 /proc/loadavg)
memfree=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
printf '{"hosted":true,"at":%s,"gateway":%s,"display":%s,"chromium":%s,"tailscale":%s,"mailWatcher":%s,"load1":%s,"memFreeMb":%s}\n' \
  "$(date +%s)000" "$(ok "$gw")" "$(ok "$disp")" "$(ok "$chrome")" "$(ok "$ts")" "$(ok "$mail")" "$load1" "$memfree" > "$OUT.tmp"
chmod 644 "$OUT.tmp"; mv "$OUT.tmp" "$OUT"
```

`chromium-policy.json`: `{ "URLBlocklist": ["chrome://*", "file://*"], "PasswordManagerEnabled": false, "SyncDisabled": true, "BrowserSignin": 0 }` installed to `/etc/chromium/policies/managed/desk.json` and `/etc/opt/chrome/policies/managed/desk.json` (the Playwright Chromium reads the former).

`cloud-init.yaml.tmpl` (placeholders `{{DESK_NAME}}`, `{{TS_AUTHKEY}}`, `{{GIT_REF}}`, `{{OWNER_TG_TARGET}}`, `{{TG_BOT_TOKEN}}`, `{{GATEWAY_TOKEN}}`): `users` (openclaw system user, no sudo), `package_update`, `packages` (§4.2 of the spec), `timezone: Asia/Kolkata`, `write_files` (keyfile from `/dev/urandom` via runcmd, units, policy, health script, `/etc/openclaw/secrets/telegram-bot-token` 0640 root:openclaw, `/root/ts-authkey` 0600, the rendered `openclaw.json` to `/home/openclaw/.openclaw/openclaw.json` 0600 owned by openclaw — with the bot token referenced as a `file` SecretRef, not inline), `runcmd` in order: NodeSource 26 install → tailscale install + `tailscale up --authkey "$(cat /root/ts-authkey)" --ssh --hostname {{DESK_NAME}}` → `shred -u /root/ts-authkey` → `git clone https://github.com/pulkitshah/openclaw /opt/openclaw && git -C /opt/openclaw checkout {{GIT_REF}}` → corepack/pnpm install (frozen, ignore-scripts, minimum-release-age env) + `pnpm build` (as root, then `chown -R root:openclaw /opt/openclaw && chmod -R g+rX,o-rwx`) → `sudo -u openclaw npx playwright install chromium` → `head -c 32 /dev/urandom > /etc/openclaw/keyfile; chown root:openclaw /etc/openclaw/keyfile; chmod 640` → `systemctl enable --now xvfb desk-health.timer openclaw-gateway` → `sudo -u openclaw /usr/bin/node /opt/openclaw/openclaw.mjs gateway --tailscale serve`-equivalent config (the config template sets `gateway.tailscale.mode: "serve"`; verify with `docs/gateway/tailscale.md` whether a CLI step is needed) → `power_state: reboot`.

`render-cloud-init.mjs`: `node deploy/desk/render-cloud-init.mjs --name <desk> --ts-authkey-file <f> --tg-token-file <f> --owner-target <id> --git-ref <ref> > /tmp/<desk>.cloud-init.yaml` — substitutes placeholders, refuses if any remains, prints nothing else.

- [ ] Steps: failing render test → implement → `shellcheck deploy/desk/*.sh` → commit `feat(desk): desk image — cloud-init, systemd units, policy, health timer`.

---

### Task 4: Operator scripts and runbook

**Files:** `deploy/desk/new-desk.sh`, `deploy/desk/roll.sh`, `deploy/desk/snapshot.sh`, `deploy/desk/README.md`; tests `deploy/desk/scripts.test.ts` (runs the scripts with a stubbed `doctl`/`ssh`/`tailscale` on `PATH` in a temp dir; asserts the doctl arguments, the skip-when-running exit code 3, and that no secret is echoed).

`new-desk.sh <desk-name> [--size s-2vcpu-4gb] [--git-ref <ref>] --ts-authkey-file <f> --tg-token-file <f> --owner-target <telegram-id> [--image <snapshot-id>]`:

1. `doctl compute ssh-key list` → pick the key named in `DESK_SSH_KEY_NAME` (default "Pulkit Macbook Pro 2025"; overridable).
2. Ensure firewall `desk-no-inbound` exists (`doctl compute firewall list`; create with `--inbound-rules ""` and outbound all).
3. Render cloud-init to a `mktemp` file (0600), `doctl compute droplet create … --user-data-file … --wait --tag-names desk`, then `doctl compute firewall add-droplets`.
4. Poll `tailscale status --json` (from the operator's Mac) for the hostname up to 15 min; print `Control UI: https://<desk>.<tailnet>.ts.net` and `Sign in: ssh <desk> 'sudo -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'`.
5. Delete the rendered cloud-init file.

`roll.sh <desk-name> [<git-ref>] [--force] [--reboot]`: over `ssh <desk-name>`: if not `--force`, query `curl -s http://127.0.0.1:18789/…`? No — use the CLI on the desk: `sudo -u openclaw node /opt/openclaw/openclaw.mjs gateway call duties.runs.recent --params '{"limit":10}' --json` and exit 3 with `desk is busy: run <id> is <status>; retry later or --force` when any run is `running`/`needs_input`/`queued`; else `git fetch && git checkout <ref>`, install (frozen), build, `chown`, `systemctl restart openclaw-gateway` (the unit enforces the 45 s → SIGKILL drain), wait for `/healthz` 200 via `curl` on the desk, print the version line from `openclaw --version`.

`snapshot.sh <desk-name>`: `doctl compute droplet-action snapshot <id> --snapshot-name desk-<name>-<date> --wait`; prune to the newest 4 `desk-<name>-*` snapshots.

`README.md` (runbook): create · first sign-in · store logins · Gmail push per desk (`openclaw duties setup` on the desk + `openclaw webhooks gmail setup … --tailscale serve`) · watch a run · parallel limit · roll · snapshot/restore · logs (`journalctl -u openclaw-gateway -u xvfb -u desk-health`) · restart recipe · troubleshooting (headless fallback → check `DISPLAY`; render 404 → `allowedHostnames`; tools missing → restart, never hot-edit config; datacenter-IP challenge → Vasudev's fallback) · tear down.

- [ ] Steps: failing script tests → implement → `shellcheck` → commit `feat(desk): new-desk, roll and snapshot scripts with a runbook`.

---

### Task 5: Docs page

**Files:** `docs/hosted-desk.md` (user-facing: what a desk is, what it costs, how to create one, what runs on it, how to reach it, limits: Linux/browser-only for now), linked from `docs/plugins/duties.md`. Run the docs link check the repo provides (`pnpm docs:check-links` or the lane `check-changed` uses). Commit `docs(desk): hosted desk guide`.

---

### Task 6: Live proof — a real desk in blr1

Preconditions from the owner: a Tailscale auth key (reusable, tagged `tag:desk` or plain, 90-day), a Telegram bot token for the desk (a NEW bot from BotFather — the owner's live bot must not be polled by two Gateways), the owner's Telegram id `5995225650`.

- [ ] `deploy/desk/new-desk.sh desk-proof --git-ref feat/hosted-desk …` from the operator's Mac (this worktree); record timings.
- [ ] Sign in over the tailnet; Logins page: store `amigos.username`/`amigos.password` (values from the owner, never printed — the implementer asks the controller to have the owner paste them into the Logins page); verify `duties.desk.status` chips all green; `duties.mail.status` after `openclaw duties setup` + `openclaw webhooks gmail setup` on the desk (Funnel is not needed: Pub/Sub push needs a public endpoint — use `--tailscale funnel` for the push endpoint only, or document that mail push on a desk needs Funnel enabled for that node).
- [ ] Copy the `book-flight-by-mail` Duty and templates from the proof Gateway export (`duties.get` JSON → `duties.save` on the desk; `duties.template.*`); run `amigos-search` twice in parallel → both ok in separate tabs; run `book-flight-by-mail` from a mail → reaches the Hold? card on the owner's Telegram (Decline).
- [ ] `roll.sh desk-proof` (no-op ref) proves the update path; `snapshot.sh desk-proof`.
- [ ] Write `docs/superpowers/plans/2026-09-14-hosted-desk-proof.md` (`git add -f`): commands (secrets redacted), timings, what failed and fixes (with commits), cost. Leave the desk running unless the owner says tear down.

---

## Self-review

**Spec coverage:** §1 ships → T1–T5; §3 provisioning → T4 (+T3 image); §4 desk → T3; §5 creds → T1; §6 parallel → T2; §7 watching → unchanged (Part 2); §8 surface/UI → T2; §9 ops → T4 runbook + T3 timer; §10 security → T3/T4 (firewall, perms, secrets handling); §11 testing → each task + T6; §12 out of scope respected.

**Placeholder scan:** cloud-init `{{…}}` are template placeholders by design, validated by the render test; no TBDs.

**Type consistency:** `DeskHealth` defined in T2 `desk.ts`, read by `duties.desk.status` and the UI; `maxParallelRuns` name identical in settings, method, UI; `createLinuxCredStore` options identical in T1 code and tests.
