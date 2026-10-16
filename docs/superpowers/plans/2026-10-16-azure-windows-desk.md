# Azure Windows Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One script run from the operator's Mac creates an Azure Windows Server VM that hosts a complete Vasudev desk (Gateway + desktop node + loopback VNC for the portal view), reachable only over the tailnet, reproducible per client.

**Architecture:** `deploy/desk/new-desk-azure.sh` creates the Azure resources with `az`, opens SSH from the operator's IP for the first minutes only, bootstraps OpenSSH on the VM with a run-command, then drives three PowerShell scripts over SSH: `first-boot.ps1` (Tailscale, TightVNC, Caddy, Node, auto sign-in, policies), `provision-desk.ps1` (fork checkout, config, Gateway task, node pairing) and `desk-health.ps1` (acceptance). The built `dist/` tree is produced on the Mac and pushed, never built on the VM. Secrets come from a per-desk env file on the Mac and travel only over SSH stdin.

**Tech Stack:** bash + `az` CLI 2.91 on macOS; PowerShell 5.1 on Windows Server 2022 Datacenter Azure Edition; Tailscale (Windows MSI, unattended mode); TightVNC 2.8 MSI; Caddy 2 (Windows zip); Node 26 + pnpm (corepack) on the VM; the fork's `openclaw gateway install` / `node install` scheduled tasks; vitest for the Mac-side script tests.

**Spec:** `docs/superpowers/specs/2026-10-16-azure-windows-desk-design.md` (git-ignored directory, force-added; `git show HEAD:<path>` prints it).

## Global Constraints

- Region `jioindiawest` for this desk (Central India stays blocked for this subscription even after the pay-as-you-go upgrade; Jio India West and Jio India Central are open at the same $43/month; the script's default stays `centralindia`), size `Standard_B2as_v2`, image `MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition:latest`, OS disk 128 GB Premium SSD; resource group `vasudev`; VM name `vasudev-<client>-az`; tailnet hostname `<client>-az`.
- No public inbound port stays open: the NSG has no inbound rules except a temporary SSH rule for the operator's current public IP that the create script removes before it exits (and on any failure after the VM exists).
- Secrets (`TS_AUTHKEY`, `DESK_ADMIN_PASSWORD`, `GATEWAY_ADMIN_PASSWORD`, `DESK_FRONT_PASSWORD`, `VNC_PASSWORD`) live in the env file on the Mac, are passed to the VM over SSH stdin as JSON, and are never on an `az` command line, in Azure custom data, in run-command parameters, in git, or in output.
- The VM's single account is `vasudev` (local administrator). Auto sign-in at boot; screen saver and lock off; `ForegroundLockTimeout = 0` for the account; Windows Update notify-only (`AUOptions = 2`, `NoAutoRebootWithLoggedOnUsers = 1`).
- TightVNC: service mode, `LoopbackOnly=1`, `AllowLoopback=1`, `AcceptHttpConnections=0`, VncAuth on, RFB port 5900, no control-interface tray icon.
- Gateway: trusted-proxy mode behind Caddy on `<tailnet-ip>:8443` (basic auth, `X-Forwarded-User`), `gateway.tailscale.mode: "serve"` for the node's own join path, `gateway.nodes.commands.allow: ["desktop.stream"]`.
- Build: `dist/` built on the Mac at the pinned commit with `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352 pnpm build` and pushed whole (it is one unit; see `office-pc-runbook.md` §10.7).
- Product copy says **Vasudev**; CLI/package/config names stay `openclaw`. American English in docs.
- Toolchain on the Mac: `PATH=$HOME/.nvm/versions/node/v26.8.2/bin:$PATH`; tests `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts`; format `node_modules/.bin/oxfmt <files>`; lanes `node scripts/check-changed.mjs` (its brand guard fails on two pre-existing untouched test files; report, do not fix here).
- Commits: Conventional Commits, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `docs/superpowers/**` files need `git add -f`.
- Creating the VM bills the subscription (~$47/month). Task 10 is the only task that creates paid resources; everything before it runs against stubs.

## Review Focus

1. **Env file missing a variable or world-readable**: the create script must refuse before any `az` call and name the variable; a 0644 env file is refused too. (Task 1 tests.)
2. **Script dies after the VM exists**: the temporary SSH rule must still be removed and the VM left in place with a clear "resume with --resume" message, never deleted and never left open. (Task 1 `trap`, Task 6 test.)
3. **Tailscale auth key rejected or expired**: `first-boot.ps1` must fail loudly and the create script must stop _without_ removing the SSH rule, so the operator can fix the key over the still-open SSH path. (Task 3 and Task 6 tests.)
4. **`dist/` pushed incompletely** (tar interrupted, CRLF conversion, a stale `extensions/*/node_modules`): the node silently stops advertising `computer.act`; the push verifies a file-count and a sha256 manifest on both ends before the Gateway task starts. (Task 5.)
5. **The console is signed out or locked after a reboot**: computer use fails with `foreground_unavailable` and the portal view shows the lock screen; `desk-health.ps1` reports `console: false` with the reason (no session / locked), and the reboot test in Task 11 pins it.

---

### Task 0: Spec amendment — SSH instead of WinRM, and the admin-path decision

**Files:**

- Modify: `docs/superpowers/specs/2026-10-16-azure-windows-desk-design.md` (section 2 "Administration" row; section 4 steps 1–3 wording "over WinRM" → "over SSH")

**Interfaces:**

- Produces: the decision every later task relies on: the VM is administered with OpenSSH Server (Windows optional feature), PowerShell as the SSH default shell, key auth only, listening on the Tailscale interface after first boot.

- [ ] **Step 1: Edit the Administration row**

Replace the row that starts with `| Administration |` by:

```markdown
| Administration | OpenSSH Server (Windows optional feature) with PowerShell as the default shell and key auth only; reachable on the VM's public IP from the operator's IP during first boot only, then on the Tailscale interface; no public inbound ports at all afterwards (NSG default-deny, no RDP) | Tailscale SSH is not available on Windows; OpenSSH reuses every `ssh`-based wait and push the Linux desks already have, and needs no WinRM client on the Mac. |
```

In section 4 replace every "over WinRM" with "over SSH" and "WinRM over HTTPS on the Tailscale interface only" with "OpenSSH Server, firewall-limited to the Tailscale interface".

- [ ] **Step 2: Format and commit**

```bash
cd /Users/pulkitshah/Developer/vasudev-openclaw-staging
export PATH=$HOME/.nvm/versions/node/v26.8.2/bin:$PATH
node_modules/.bin/oxfmt docs/superpowers/specs/2026-10-16-azure-windows-desk-design.md
git diff --check
git add -f docs/superpowers/specs/2026-10-16-azure-windows-desk-design.md
git commit -m "docs(desk): Azure Windows desk spec — administer over OpenSSH, not WinRM

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: `new-desk-azure.sh` — argument parsing, env file contract, Azure resource creation (stubbed)

**Files:**

- Create: `deploy/desk/new-desk-azure.sh`
- Modify: `deploy/desk/scripts.test.ts` (add an `az` stub to `installStubs`, a `describe("new-desk-azure.sh")` block)
- Reference: `deploy/desk/new-desk-oci.sh` (structure to mirror), `deploy/desk/lib/desk-ops.sh` (`desk_wait_for_tailnet_host`, `desk_wait_for_gateway`, `desk_print_ready`)

**Interfaces:**

- Consumes: `desk_wait_for_tailnet_host <name> <seconds>` → prints MagicDNS host; `desk_wait_for_gateway <name> <url> <seconds> <interval>`.
- Produces: `new-desk-azure.sh <desk-name> --env-file <file> [--client <slug>] [--git-ref <ref>] [--size Standard_B2as_v2] [--location centralindia] [--os-disk-gb 128] [--resume]`. Env file keys (all required): `OWNER_EMAIL`, `TS_AUTHKEY`, `DESK_ADMIN_PASSWORD`, `GATEWAY_ADMIN_PASSWORD`, `DESK_FRONT_PASSWORD`, `VNC_PASSWORD`, `WHITELIST_ADDRESSES` (comma-separated, may be empty). Environment overrides: `AZ_CLI`, `DESK_AZ_RESOURCE_GROUP` (default `vasudev`), `DESK_AZ_VNET` (default `vasudev`), `DESK_AZ_SUBNET` (default `desks`), `DESK_AZ_NSG` (default `vasudev-desks`), `DESK_OPERATOR_IP` (default: `curl -fsS https://api.ipify.org`), `DESK_SSH_PUBLIC_KEY`, `DESK_POLL_SECONDS`, `DESK_READY_POLL_SECONDS`. Functions later tasks call: `azure_open_operator_ssh`, `azure_close_operator_ssh`, `azure_vm_public_ip`.

- [ ] **Step 1: Write the failing tests**

Add to `installStubs` in `deploy/desk/scripts.test.ts` an `az` stub that logs argv and answers the handful of calls the script parses:

```ts
writeStub(
  binDir,
  "az",
  `set -euo pipefail
printf '%s\\n' "az $*" >> "\${AZ_LOG:?}"
args="$*"
case "$args" in
  "account show"*)            printf '%s' "\${AZ_ACCOUNT_JSON:-{\\"id\\":\\"sub-fixture\\",\\"state\\":\\"Enabled\\"}}" ;;
  "group exists"*)            printf '%s' "\${AZ_GROUP_EXISTS:-false}" ;;
  "network vnet show"*)       [ "\${AZ_VNET_EXISTS:-0}" = 1 ] && printf '{"name":"vasudev"}' || exit 3 ;;
  "network nsg show"*)        [ "\${AZ_NSG_EXISTS:-0}" = 1 ] && printf '{"name":"vasudev-desks"}' || exit 3 ;;
  "vm show"*)                 [ "\${AZ_VM_EXISTS:-0}" = 1 ] && printf '%s' "\${AZ_VM_SHOW_JSON:-{\\"name\\":\\"x\\"}}" || exit 3 ;;
  "vm create"*)               printf '%s' "\${AZ_VM_CREATE_JSON:-{\\"publicIpAddress\\":\\"20.0.0.5\\"}}" ;;
  "vm list-ip-addresses"*)    printf '%s' "\${AZ_VM_IPS_JSON:-[{\\"virtualMachine\\":{\\"network\\":{\\"publicIpAddresses\\":[{\\"ipAddress\\":\\"20.0.0.5\\"}]}}}]}" ;;
  "vm run-command invoke"*)   printf '%s' "\${AZ_RUN_COMMAND_JSON:-{\\"value\\":[{\\"message\\":\\"bootstrap-ssh: ok\\"}]}}" ;;
  *) : ;;
esac
exit 0`,
);
```

Then the first tests:

```ts
describe("new-desk-azure.sh", () => {
  const deskName = "vasudev-acme-az";
  let envFile: string;
  let azLog: string;

  beforeEach(() => {
    envFile = join(dir, "acme.env");
    writeFileSync(
      envFile,
      [
        "OWNER_EMAIL=owner@example.com",
        `TS_AUTHKEY=${TS_AUTHKEY_SECRET}`,
        "DESK_ADMIN_PASSWORD=Fixture-Admin-Pass-1!",
        "GATEWAY_ADMIN_PASSWORD=fixture-gateway-admin",
        "DESK_FRONT_PASSWORD=fixture-front",
        "VNC_PASSWORD=fixtvnc1",
        "WHITELIST_ADDRESSES=203.0.113.10,203.0.113.11",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(join(dir, "fixture.pub"), "ssh-ed25519 AAAAfixture fixture@test\n");
    azLog = join(dir, "az.log");
  });

  function azureEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      AZ_LOG: azLog,
      DESK_OPERATOR_IP: "198.51.100.7",
      DESK_SSH_PUBLIC_KEY: join(dir, "fixture.pub"),
      DESK_POLL_SECONDS: "5",
      DESK_SSH_WAIT_SECONDS: "5",
      TAILSCALE_STATUS_JSON: JSON.stringify({
        MagicDNSSuffix: "tailnet-fixture.ts.net.",
        Peer: { peer1: { HostName: "acme-az", Online: true } },
      }),
      ...extra,
    };
  }

  it("refuses an env file that is missing a key, before any az call", () => {
    writeFileSync(envFile, "OWNER_EMAIL=owner@example.com\n", { mode: 0o600 });
    const result = run(NEW_DESK_AZURE, [deskName, "--env-file", envFile], azureEnv());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TS_AUTHKEY");
    expect(existsSync(azLog)).toBe(false);
  });

  it("refuses a group- or world-readable env file", () => {
    chmodSync(envFile, 0o644);
    const result = run(NEW_DESK_AZURE, [deskName, "--env-file", envFile], azureEnv());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("0600");
    expect(existsSync(azLog)).toBe(false);
  });

  it("creates group, network, NSG with a temporary operator SSH rule, and the VM, in that order", () => {
    const result = run(
      NEW_DESK_AZURE,
      [deskName, "--env-file", envFile, "--client", "acme", "--stop-after", "create"],
      azureEnv(),
    );
    expect(result.status, result.stderr).toBe(0);
    const calls = readLog(azLog).split("\n");
    const idx = (needle: string) => calls.findIndex((line) => line.includes(needle));
    expect(idx("group create --name vasudev --location centralindia")).toBeGreaterThanOrEqual(0);
    expect(idx("network vnet create")).toBeGreaterThan(idx("group create"));
    expect(idx("network nsg create --name vasudev-desks")).toBeGreaterThan(
      idx("network vnet create"),
    );
    expect(idx("network nsg rule create")).toBeGreaterThan(idx("network nsg create"));
    const rule = calls[idx("network nsg rule create")];
    expect(rule).toContain("--source-address-prefixes 198.51.100.7/32");
    expect(rule).toContain("--destination-port-ranges 22");
    expect(rule).toContain("--name operator-ssh-temp");
    const create = calls[idx("vm create")];
    expect(create).toContain(`--name ${deskName}`);
    expect(create).toContain(
      "--image MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition:latest",
    );
    expect(create).toContain("--size Standard_B2as_v2");
    expect(create).toContain("--os-disk-size-gb 128");
    expect(create).toContain("--storage-sku Premium_LRS");
    expect(create).toContain("--admin-username vasudev");
    expect(create).toContain("--nsg vasudev-desks");
    expect(create).toContain("--public-ip-sku Standard");
    expect(create).not.toContain("Fixture-Admin-Pass-1!");
    expect(create).toContain("--admin-password @");
    expect(readLog(azLog)).not.toContain(TS_AUTHKEY_SECRET);
  });

  it("reuses existing group, network and NSG on a rerun", () => {
    const result = run(
      NEW_DESK_AZURE,
      [deskName, "--env-file", envFile, "--stop-after", "create"],
      azureEnv({ AZ_GROUP_EXISTS: "true", AZ_VNET_EXISTS: "1", AZ_NSG_EXISTS: "1" }),
    );
    expect(result.status, result.stderr).toBe(0);
    const log = readLog(azLog);
    expect(log).not.toContain("group create");
    expect(log).not.toContain("vnet create");
    expect(log).not.toContain("nsg create --name");
    expect(log).toContain("vm create");
  });
});
```

Add `const NEW_DESK_AZURE = join(HERE, "new-desk-azure.sh");` next to the other constants and import `chmodSync` from `node:fs`. The `--stop-after create` flag exists only so tests can stop before the SSH phase; it is documented in `usage()`.

`--admin-password @<file>`: `az` reads an argument value from a file when it is `@path`; the script writes the password to a `mktemp` 0600 file deleted on exit, so the secret never appears in argv.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts -t "new-desk-azure"`
Expected: FAIL — `new-desk-azure.sh` not found (spawn ENOENT) for every case.

- [ ] **Step 3: Write the script (phase 1: parse, validate, create)**

```bash
#!/usr/bin/env bash
# Creates one hosted Vasudev desk on an Azure Windows Server VM: Gateway + desktop node on the same
# box, loopback TightVNC for the portal's Desktop view, Tailscale-only reachability. Run from the
# operator's Mac with `az login` done and `tailscale` on the desk's tailnet. See
# deploy/desk/README.md ("Azure Windows desk") and deploy/desk/windows-desk-runbook.md.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: new-desk-azure.sh <desk-name> --env-file <file> [--client <slug>] [--git-ref <ref>]
                          [--size Standard_B2as_v2] [--location centralindia] [--os-disk-gb 128]
                          [--resume] [--stop-after create|first-boot]

Creates the Azure resources (resource group, VNet, NSG, VM), opens SSH from this machine's public
IP for the first minutes only, bootstraps OpenSSH on the VM, runs the Windows first-boot and desk
provisioning scripts over SSH, pushes the fork build from this checkout, pairs the desktop node,
closes the temporary SSH rule, and prints the Control UI URL. Idempotent: rerun with --resume to
continue a run that stopped after the VM existed.

Required:
  <desk-name>          VM name, e.g. vasudev-acme-az. The tailnet hostname is <desk-name> minus
                       the "vasudev-" prefix (acme-az).
  --env-file <file>    0600 file with OWNER_EMAIL, TS_AUTHKEY, DESK_ADMIN_PASSWORD,
                       GATEWAY_ADMIN_PASSWORD, DESK_FRONT_PASSWORD, VNC_PASSWORD,
                       WHITELIST_ADDRESSES (comma-separated, may be empty). Never printed.

Optional:
  --client <slug>      Display name slug for the node ("<slug> desktop"); default: from desk-name.
  --git-ref <ref>      Fork commit to deploy (default: this checkout's HEAD).
  --size <sku>         VM size (default: Standard_B2as_v2).
  --location <region>  Azure region (default: centralindia).
  --os-disk-gb <n>     OS disk size (default: 128).
  --resume             Skip creation of resources that already exist and continue.
  --stop-after <phase> Stop after "create" (resources only) or "first-boot" (tests and rehearsal).

Environment overrides:
  AZ_CLI                   the az executable (default: az)
  DESK_AZ_RESOURCE_GROUP   (default: vasudev)       DESK_AZ_VNET (default: vasudev)
  DESK_AZ_SUBNET           (default: desks)         DESK_AZ_NSG  (default: vasudev-desks)
  DESK_OPERATOR_IP         public IP allowed to SSH during first boot (default: api.ipify.org)
  DESK_SSH_PUBLIC_KEY      public key for the vasudev account (default: ~/.ssh/id_ed25519.pub)
  DESK_SSH_WAIT_SECONDS    wait for SSH on the public IP (default: 600)
  DESK_POLL_SECONDS        wait for the tailnet hostname (default: 900)
  DESK_READY_POLL_SECONDS  wait for the Gateway /healthz (default: 1800)
EOF
}

AZ_CLI="${AZ_CLI:-az}"
for cmd in "$AZ_CLI" jq tailscale curl ssh tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "new-desk-azure.sh: \"$cmd\" is required but not found on PATH — see deploy/desk/README.md (Azure Windows desk)" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/desk-ops.sh
source "$SCRIPT_DIR/lib/desk-ops.sh"
WINDOWS_DIR="$SCRIPT_DIR/windows"

DESK_AZ_RESOURCE_GROUP="${DESK_AZ_RESOURCE_GROUP:-vasudev}"
DESK_AZ_VNET="${DESK_AZ_VNET:-vasudev}"
DESK_AZ_SUBNET="${DESK_AZ_SUBNET:-desks}"
DESK_AZ_NSG="${DESK_AZ_NSG:-vasudev-desks}"
DESK_SSH_WAIT_SECONDS="${DESK_SSH_WAIT_SECONDS:-600}"
DESK_POLL_SECONDS="${DESK_POLL_SECONDS:-900}"
DESK_READY_POLL_SECONDS="${DESK_READY_POLL_SECONDS:-1800}"
DESK_READY_POLL_INTERVAL_SECONDS="${DESK_READY_POLL_INTERVAL_SECONDS:-10}"
OPERATOR_RULE_NAME="operator-ssh-temp"

desk_name=""; env_file=""; client=""; git_ref=""
size="Standard_B2as_v2"; location="centralindia"; os_disk_gb=128
resume=0; stop_after=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) env_file="$2"; shift 2 ;;
    --client) client="$2"; shift 2 ;;
    --git-ref) git_ref="$2"; shift 2 ;;
    --size) size="$2"; shift 2 ;;
    --location) location="$2"; shift 2 ;;
    --os-disk-gb) os_disk_gb="$2"; shift 2 ;;
    --resume) resume=1; shift ;;
    --stop-after) stop_after="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "new-desk-azure.sh: unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [[ -n "$desk_name" ]]; then echo "new-desk-azure.sh: unexpected argument: $1" >&2; exit 2; fi
      desk_name="$1"; shift ;;
  esac
done
if [[ -z "$desk_name" || -z "$env_file" ]]; then usage >&2; exit 2; fi
if ! [[ "$desk_name" =~ ^[a-z0-9-]{3,40}$ ]]; then
  echo "new-desk-azure.sh: desk-name must be lowercase letters, digits and dashes (got \"$desk_name\")" >&2; exit 2
fi
case "$stop_after" in "" | create | first-boot) ;; *) echo "new-desk-azure.sh: --stop-after takes create or first-boot" >&2; exit 2 ;; esac
tailnet_name="${desk_name#vasudev-}"
client="${client:-${tailnet_name%-az}}"
git_ref="${git_ref:-$(git -C "$SCRIPT_DIR" rev-parse HEAD)}"

# The env file is the only place secrets live on this side. It is read with `set -a` in a subshell
# so nothing leaks into this process's environment except the seven named variables, and it must
# be private: a readable env file is the whole desk's keys in one place.
if [[ ! -f "$env_file" ]]; then echo "new-desk-azure.sh: env file not found: $env_file" >&2; exit 2; fi
env_mode="$(stat -f '%Lp' "$env_file" 2>/dev/null || stat -c '%a' "$env_file")"
if [[ "$env_mode" != "600" && "$env_mode" != "400" ]]; then
  echo "new-desk-azure.sh: $env_file must be mode 0600 (is $env_mode)" >&2; exit 2
fi
for key in OWNER_EMAIL TS_AUTHKEY DESK_ADMIN_PASSWORD GATEWAY_ADMIN_PASSWORD DESK_FRONT_PASSWORD VNC_PASSWORD WHITELIST_ADDRESSES; do
  if ! grep -q "^${key}=" "$env_file"; then
    echo "new-desk-azure.sh: $env_file is missing ${key}=" >&2; exit 2
  fi
done
env_get() { sed -n "s/^$1=//p" "$env_file" | head -n1; }
owner_email="$(env_get OWNER_EMAIL)"
vnc_password="$(env_get VNC_PASSWORD)"
if (( ${#vnc_password} < 6 || ${#vnc_password} > 8 )); then
  echo "new-desk-azure.sh: VNC_PASSWORD must be 6-8 characters (TightVNC uses the first 8)" >&2; exit 2
fi

ssh_public_key="${DESK_SSH_PUBLIC_KEY:-}"
if [[ -z "$ssh_public_key" ]]; then
  for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    [[ -f "$candidate" ]] && { ssh_public_key="$candidate"; break; }
  done
fi
if [[ -z "$ssh_public_key" || ! -f "$ssh_public_key" ]]; then
  echo "new-desk-azure.sh: no SSH public key found — set DESK_SSH_PUBLIC_KEY" >&2; exit 1
fi
operator_ip="${DESK_OPERATOR_IP:-$(curl -fsS --max-time 10 https://api.ipify.org)}"
if ! [[ "$operator_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "new-desk-azure.sh: could not determine this machine's public IPv4 — set DESK_OPERATOR_IP" >&2; exit 1
fi

"$AZ_CLI" account show --output json >/dev/null || { echo "new-desk-azure.sh: run \`az login\` first" >&2; exit 1; }

# Temporary files carry secrets for az (@file arguments) and the SSH payloads; 0600 and deleted on
# exit. The operator SSH rule is closed on exit too, but only once the VM exists and first boot
# has not failed on the Tailscale join (the operator needs SSH to fix that).
tmpdir="$(mktemp -d)"; chmod 700 "$tmpdir"
vm_exists=0; keep_operator_ssh=0
azure_close_operator_ssh() {
  "$AZ_CLI" network nsg rule delete --resource-group "$DESK_AZ_RESOURCE_GROUP" --nsg-name "$DESK_AZ_NSG" --name "$OPERATOR_RULE_NAME" --output none 2>/dev/null || true
}
cleanup() {
  local status=$?
  if (( vm_exists == 1 && keep_operator_ssh == 0 )); then azure_close_operator_ssh; fi
  rm -rf "$tmpdir"
  if (( status != 0 && vm_exists == 1 )); then
    echo "new-desk-azure.sh: stopped with the VM in place — fix the cause and rerun with --resume" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

echo "==> Resource group $DESK_AZ_RESOURCE_GROUP in $location" >&2
if [[ "$("$AZ_CLI" group exists --name "$DESK_AZ_RESOURCE_GROUP")" != "true" ]]; then
  "$AZ_CLI" group create --name "$DESK_AZ_RESOURCE_GROUP" --location "$location" --output none
fi
echo "==> Network $DESK_AZ_VNET / $DESK_AZ_SUBNET" >&2
if ! "$AZ_CLI" network vnet show --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$DESK_AZ_VNET" --output none 2>/dev/null; then
  "$AZ_CLI" network vnet create --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$DESK_AZ_VNET" --location "$location" \
    --address-prefixes 10.30.0.0/16 --subnet-name "$DESK_AZ_SUBNET" --subnet-prefixes 10.30.1.0/24 --output none
fi
echo "==> Security group $DESK_AZ_NSG (no inbound rules except the temporary operator SSH)" >&2
if ! "$AZ_CLI" network nsg show --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$DESK_AZ_NSG" --output none 2>/dev/null; then
  "$AZ_CLI" network nsg create --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$DESK_AZ_NSG" --location "$location" --output none
fi
azure_open_operator_ssh() {
  "$AZ_CLI" network nsg rule create --resource-group "$DESK_AZ_RESOURCE_GROUP" --nsg-name "$DESK_AZ_NSG" \
    --name "$OPERATOR_RULE_NAME" --priority 100 --direction Inbound --access Allow --protocol Tcp \
    --source-address-prefixes "${operator_ip}/32" --destination-port-ranges 22 --output none
}
azure_vm_public_ip() {
  "$AZ_CLI" vm list-ip-addresses --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$desk_name" --output json \
    | jq -r '.[0].virtualMachine.network.publicIpAddresses[0].ipAddress // empty'
}
azure_open_operator_ssh

if "$AZ_CLI" vm show --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$desk_name" --output none 2>/dev/null; then
  if (( resume == 0 )); then
    echo "new-desk-azure.sh: VM \"$desk_name\" already exists — rerun with --resume to continue provisioning it" >&2; exit 1
  fi
  vm_exists=1
  echo "==> VM $desk_name exists; resuming" >&2
else
  admin_password_file="$tmpdir/admin-password"; : > "$admin_password_file"; chmod 600 "$admin_password_file"
  env_get DESK_ADMIN_PASSWORD > "$admin_password_file"
  echo "==> Creating VM $desk_name ($size, $os_disk_gb GB, Windows Server 2022 Azure Edition)" >&2
  "$AZ_CLI" vm create --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$desk_name" --location "$location" \
    --image "MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition:latest" --size "$size" \
    --os-disk-size-gb "$os_disk_gb" --storage-sku Premium_LRS \
    --admin-username vasudev --admin-password "@${admin_password_file}" \
    --vnet-name "$DESK_AZ_VNET" --subnet "$DESK_AZ_SUBNET" --nsg "$DESK_AZ_NSG" --nsg-rule NONE \
    --public-ip-sku Standard --public-ip-address "${desk_name}-ip" \
    --license-type None --output json > "$tmpdir/vm-create.json"
  vm_exists=1
fi
public_ip="$(azure_vm_public_ip)"
echo "==> Public IP: ${public_ip:-unknown} (SSH from ${operator_ip} only, until first boot completes)" >&2
if [[ "$stop_after" == "create" ]]; then
  echo "==> Stopping after create (--stop-after create)" >&2
  exit 0
fi
```

The remaining phases are added in Task 4 and Task 6; until then the script ends here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts -t "new-desk-azure"`
Expected: PASS (4 tests). Also `bash -n deploy/desk/new-desk-azure.sh` prints nothing.

- [ ] **Step 5: Format, make executable, commit**

```bash
chmod +x deploy/desk/new-desk-azure.sh
node_modules/.bin/oxfmt deploy/desk/scripts.test.ts
git add deploy/desk/new-desk-azure.sh deploy/desk/scripts.test.ts
git commit -m "feat(desk): new-desk-azure.sh — env-file contract and Azure resource creation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `windows/bootstrap-ssh.ps1` — OpenSSH Server through a run-command, no secrets

**Files:**

- Create: `deploy/desk/windows/bootstrap-ssh.ps1`
- Create: `deploy/desk/windows/scripts.test.ts` (PowerShell parse checks; skipped when `pwsh` is absent)
- Modify: `deploy/desk/new-desk-azure.sh` (append the run-command + SSH wait phase)
- Modify: `deploy/desk/scripts.test.ts` (one test)

**Interfaces:**

- Consumes: `azure_vm_public_ip`.
- Produces: the VM accepts `ssh vasudev@<public-ip>` with the operator's key, PowerShell as the shell; the script prints `bootstrap-ssh: ok` as its last line. `ssh_vm <ip-or-host> <powershell command>` and `ssh_vm_script <ip-or-host> <local .ps1> <json-on-stdin>` helpers in `new-desk-azure.sh` for every later phase.

- [ ] **Step 1: Write the failing tests**

`deploy/desk/windows/scripts.test.ts`:

```ts
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Parses every PowerShell script in this directory with PowerShell 7 (`brew install powershell`
// on the Mac). Catches syntax errors before a script ever runs on a client VM; skipped where pwsh
// is not installed so the lane stays green on CI runners without it.
const HERE = dirname(fileURLToPath(import.meta.url));
const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
  encoding: "utf8",
});
const hasPwsh = pwsh.status === 0;

describe.runIf(hasPwsh)("deploy/desk/windows PowerShell scripts", () => {
  const scripts = readdirSync(HERE).filter((name) => name.endsWith(".ps1"));
  it("has scripts to check", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });
  it.each(scripts)("%s parses without errors", (name) => {
    const check = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${join(HERE, name)}',[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|ForEach-Object{$_.ToString()}; exit 1}`,
      ],
      { encoding: "utf8" },
    );
    expect(check.status, check.stdout + check.stderr).toBe(0);
  });
  it.each(scripts)("%s uses CRLF-safe constructs: no here-strings terminated mid-line", (name) => {
    const text = readFileSync(join(HERE, name), "utf8");
    expect(text.includes("\r")).toBe(false);
  });
});
```

(add `readFileSync` to the fs import.) And in `deploy/desk/scripts.test.ts`:

```ts
it("bootstraps OpenSSH with a run-command that carries the operator key and no secrets, then waits for SSH", () => {
  const result = run(
    NEW_DESK_AZURE,
    [deskName, "--env-file", envFile, "--stop-after", "first-boot", "--skip-first-boot"],
    azureEnv({ SSH_EXIT_CODE: "0" }),
  );
  expect(result.status, result.stderr).toBe(0);
  const log = readLog(azLog);
  const runCommand = log.split("\n").find((line) => line.includes("vm run-command invoke")) ?? "";
  expect(runCommand).toContain("--command-id RunPowerShellScript");
  expect(runCommand).toContain("--scripts @");
  expect(runCommand).toContain("--parameters PublicKey=ssh-ed25519 AAAAfixture fixture@test");
  expect(runCommand).not.toContain("Fixture-Admin-Pass-1!");
  expect(readLog(sshLog)).toContain("vasudev@20.0.0.5");
});
```

`--skip-first-boot` is a test-only flag (documented in `usage()` under "testing") that stops after the SSH wait. Extend the existing `ssh` stub (it logs argv to `SSH_LOG`) so that it also appends its stdin to `${SSH_STDIN_LOG}` when that variable is set, prints `${SSH_STDOUT}` (newline-separated, one line per call in order; the stub keeps a counter file next to `SSH_LOG`) and exits `${SSH_EXIT_CODE:-0}`; set `SSH_LOG: sshLog, SSH_STDIN_LOG: join(dir, "ssh-stdin.log")` in `azureEnv()`. The `ready` probe (`Write-Output ready`) must print `ready`: make the stub print `ready` whenever its argv contains `Write-Output ready`, regardless of `SSH_STDOUT`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts deploy/desk/windows/scripts.test.ts -t "bootstraps OpenSSH|parses"`
Expected: FAIL — unknown option `--skip-first-boot`; the windows test file finds no scripts.

- [ ] **Step 3: Write `bootstrap-ssh.ps1`**

```powershell
# Runs once through `az vm run-command invoke` as SYSTEM: turns on the OpenSSH Server feature,
# trusts the operator's public key for the vasudev administrator, makes PowerShell the SSH shell,
# and opens port 22 in the Windows firewall. Carries no secrets: the key is public, the password
# never passes through here. Everything after this step happens over SSH.
param([Parameter(Mandatory = $true)][string]$PublicKey)
$ErrorActionPreference = "Stop"

$cap = Get-WindowsCapability -Online | Where-Object Name -like "OpenSSH.Server*"
if ($cap.State -ne "Installed") { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

# Administrators authenticate against this one file, not their own ~/.ssh; sshd refuses it unless
# only SYSTEM and Administrators can read it.
$authKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
Set-Content -Path $authKeys -Value $PublicKey -Encoding ascii
icacls $authKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null

# Password auth off: the NSG limits who can reach port 22, the key limits who gets in.
$cfg = "C:\ProgramData\ssh\sshd_config"
$lines = Get-Content $cfg | Where-Object { $_ -notmatch "^\s*#?\s*PasswordAuthentication" }
$lines += "PasswordAuthentication no"
Set-Content -Path $cfg -Value $lines -Encoding ascii
Restart-Service sshd

if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
"bootstrap-ssh: ok"
```

- [ ] **Step 4: Append the run-command and SSH-wait phase to `new-desk-azure.sh`**

Add `--skip-first-boot` to the option parser (`skip_first_boot=1`) and after the `--stop-after create` block:

```bash
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts_vasudev_desks")
# Runs one PowerShell command on the VM. Output comes back as-is (CRLF stripped).
ssh_vm() { local host="$1"; shift; ssh "${ssh_opts[@]}" "vasudev@${host}" "$@" | tr -d '\r'; }
# Runs a local .ps1 on the VM. Two SSH calls: the script body is written to C:\opt\stage\<name>
# from stdin (no command-line length limit, no quoting), then executed with the JSON parameters on
# stdin, so no secret is ever in argv or in a file on the VM.
ssh_vm_script() {
  local host="$1" script="$2" json_file="$3"
  local name; name="$(basename "$script")"
  ssh "${ssh_opts[@]}" "vasudev@${host}" 'powershell.exe -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force -Path C:\opt\stage | Out-Null; [IO.File]::WriteAllText(\"C:\opt\stage\'"$name"'\", [Console]::In.ReadToEnd())"' < "$script"
  ssh "${ssh_opts[@]}" "vasudev@${host}" "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\opt\stage\${name}" < "$json_file" | tr -d '\r'
}

echo "==> Bootstrapping OpenSSH on the VM (run-command, no secrets)" >&2
"$AZ_CLI" vm run-command invoke --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$desk_name" \
  --command-id RunPowerShellScript --scripts "@${WINDOWS_DIR}/bootstrap-ssh.ps1" \
  --parameters "PublicKey=$(cat "$ssh_public_key")" --output json > "$tmpdir/bootstrap.json"
if ! jq -e '.value[]?.message | select(contains("bootstrap-ssh: ok"))' "$tmpdir/bootstrap.json" >/dev/null; then
  echo "new-desk-azure.sh: bootstrap-ssh.ps1 did not report ok:" >&2; jq -r '.value[]?.message' "$tmpdir/bootstrap.json" >&2; exit 1
fi
echo "==> Waiting up to ${DESK_SSH_WAIT_SECONDS}s for SSH at ${public_ip}" >&2
ssh_deadline=$((SECONDS + DESK_SSH_WAIT_SECONDS))
until ssh_vm "$public_ip" 'Write-Output ready' 2>/dev/null | grep -q '^ready$'; do
  if (( SECONDS >= ssh_deadline )); then
    echo "new-desk-azure.sh: SSH to vasudev@${public_ip} never answered — check the NSG rule and \`az vm run-command invoke\` output" >&2; exit 1
  fi
  sleep 10
done
if (( skip_first_boot == 1 )); then exit 0; fi
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts deploy/desk/windows/scripts.test.ts -t "bootstraps OpenSSH|parses|has scripts"`
Expected: PASS. If `pwsh` is missing on the Mac: `brew install powershell` first; the windows tests must run at least once on the Mac during this plan.

- [ ] **Step 6: Commit**

```bash
node_modules/.bin/oxfmt deploy/desk/scripts.test.ts deploy/desk/windows/scripts.test.ts
git add deploy/desk/windows/bootstrap-ssh.ps1 deploy/desk/windows/scripts.test.ts deploy/desk/new-desk-azure.sh deploy/desk/scripts.test.ts
git commit -m "feat(desk): OpenSSH bootstrap for Azure Windows desks (run-command, operator key only)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `windows/first-boot.ps1` — Tailscale, TightVNC, Caddy, Node, auto sign-in, policies

**Files:**

- Create: `deploy/desk/windows/first-boot.ps1`
- Create: `deploy/desk/windows/downloads.json` (pinned URLs + sha256)
- Create: `deploy/desk/windows/Caddyfile.tmpl`
- Test: `deploy/desk/windows/scripts.test.ts` (parse check covers it; add a `downloads.json` shape test)

**Interfaces:**

- Consumes: JSON on stdin `{ "tailnetName": "acme-az", "tsAuthKey": "...", "adminPassword": "...", "vncPassword": "...", "frontPassword": "...", "ownerEmail": "...", "gitRef": "<sha>" }`.
- Produces: Tailscale joined (unattended), TightVNC service on `127.0.0.1:5900`, Caddy task at startup serving `Caddyfile` rendered from the template at `C:\opt\caddy\Caddyfile`, Node 26 + git + pnpm on PATH, `C:\opt` created, auto sign-in set, policies set, then `Restart-Computer`. Prints `first-boot: ok` before the reboot. On a Tailscale join failure prints `first-boot: tailscale-failed <reason>` and exits 3 without rebooting.

- [ ] **Step 1: Write the failing `downloads.json` test**

In `deploy/desk/windows/scripts.test.ts`:

```ts
import downloads from "./downloads.json" with { type: "json" };

describe("downloads.json", () => {
  it("pins every installer with an https url and a 64-hex sha256", () => {
    for (const [name, entry] of Object.entries(
      downloads as Record<string, { url: string; sha256: string }>,
    )) {
      expect(entry.url, name).toMatch(/^https:\/\//);
      expect(entry.sha256, name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(downloads)).toEqual(
      expect.arrayContaining(["tailscale", "tightvnc", "caddy", "node", "git", "autologon"]),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/run-vitest.mjs run deploy/desk/windows/scripts.test.ts -t downloads`
Expected: FAIL — cannot find module `./downloads.json`.

- [ ] **Step 3: Pin the downloads**

Download each file once on the Mac, record its sha256, and write `deploy/desk/windows/downloads.json`:

```bash
cd "$(mktemp -d)"
curl -fsSLO https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi      # then read the real version from the MSI name on the page and pin that URL
curl -fsSLO https://www.tightvnc.com/download/2.8.89/tightvnc-2.8.89-gpl-setup-64bit.msi
curl -fsSL -o caddy.zip "https://caddyserver.com/api/download?os=windows&arch=amd64"   # pin to a GitHub release asset instead: https://github.com/caddyserver/caddy/releases/download/v2.10.0/caddy_2.10.0_windows_amd64.zip
curl -fsSLO https://nodejs.org/dist/v26.8.2/node-v26.8.2-x64.msi
curl -fsSLO https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/MinGit-2.51.0-64-bit.zip
curl -fsSLO https://download.sysinternals.com/files/AutoLogon.zip
shasum -a 256 *
```

Use the exact version numbers that exist at implementation time (check each release page); the JSON shape is:

```json
{
  "tailscale": {
    "url": "https://pkgs.tailscale.com/stable/tailscale-setup-1.102.4-amd64.msi",
    "sha256": "<64 hex>"
  },
  "tightvnc": {
    "url": "https://www.tightvnc.com/download/2.8.89/tightvnc-2.8.89-gpl-setup-64bit.msi",
    "sha256": "<64 hex>"
  },
  "caddy": {
    "url": "https://github.com/caddyserver/caddy/releases/download/v2.10.0/caddy_2.10.0_windows_amd64.zip",
    "sha256": "<64 hex>"
  },
  "node": { "url": "https://nodejs.org/dist/v26.8.2/node-v26.8.2-x64.msi", "sha256": "<64 hex>" },
  "git": {
    "url": "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/MinGit-2.51.0-64-bit.zip",
    "sha256": "<64 hex>"
  },
  "autologon": {
    "url": "https://download.sysinternals.com/files/AutoLogon.zip",
    "sha256": "<64 hex>"
  }
}
```

`<64 hex>` is replaced by the values `shasum` printed; the test refuses anything else.

- [ ] **Step 4: Write `Caddyfile.tmpl`**

```
# Rendered by first-boot.ps1 to C:\opt\caddy\Caddyfile. The desk's own front: the front-door box
# reaches this listener over the tailnet with basic auth, and Caddy mints X-Forwarded-User for the
# loopback Gateway (gateway.auth.mode trusted-proxy, allowLoopback). Plain HTTP: WireGuard already
# encrypts the hop. Same shape as the office-PC desk and Prabhat.
{
	admin off
}

http://{{TAILNET_IP}}:8443 {
	basicauth {
		{{OWNER_EMAIL}} {{FRONT_PASSWORD_BCRYPT}}
	}
	reverse_proxy 127.0.0.1:18789 {
		header_up X-Forwarded-User {http.auth.user.id}
		header_up Host {upstream_hostport}
	}
}
```

- [ ] **Step 5: Write `first-boot.ps1`**

```powershell
# First boot of an Azure Windows desk. Runs over SSH as the vasudev administrator with a JSON
# document on stdin (never argv): tailnetName, tsAuthKey, adminPassword, vncPassword,
# frontPassword, ownerEmail, gitRef. Installs the pinned downloads (deploy/desk/windows/downloads.json
# is embedded below by new-desk-azure.sh as $Downloads), joins the tailnet unattended, installs
# TightVNC loopback-only, Caddy as a startup task, Node 26 + MinGit + pnpm, sets auto sign-in and
# the desk policies, then reboots into the signed-in console. Idempotent: every step checks first.
$ErrorActionPreference = "Stop"
$input = [Console]::In.ReadToEnd() | ConvertFrom-Json
$Downloads = ConvertFrom-Json @'
{{DOWNLOADS_JSON}}
'@
$opt = "C:\opt"; $dl = "C:\opt\downloads"
New-Item -ItemType Directory -Force -Path $opt, $dl, "$opt\caddy", "$opt\bin" | Out-Null

function Get-Pinned([string]$name) {
  $entry = $Downloads.$name
  $file = Join-Path $dl ([IO.Path]::GetFileName(([Uri]$entry.url).AbsolutePath))
  if (-not (Test-Path $file) -or (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $entry.sha256) {
    Invoke-WebRequest -Uri $entry.url -OutFile $file -UseBasicParsing
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $entry.sha256) { throw "first-boot: $name sha256 mismatch ($actual)" }
  }
  return $file
}
function Install-Msi([string]$file, [string[]]$props) {
  $p = Start-Process msiexec.exe -ArgumentList (@("/i", "`"$file`"", "/quiet", "/norestart") + $props) -Wait -PassThru
  if ($p.ExitCode -notin 0, 3010) { throw "first-boot: msiexec $file exited $($p.ExitCode)" }
}

# 1. Tailscale, unattended (runs before sign-in), joins with the pre-auth key. Failure here is
#    reported and stops the script WITHOUT rebooting: the operator still has SSH on the public IP.
if (-not (Test-Path "C:\Program Files\Tailscale\tailscale.exe")) { Install-Msi (Get-Pinned "tailscale") @() }
$ts = "C:\Program Files\Tailscale\tailscale.exe"
$status = & $ts status --json 2>$null | ConvertFrom-Json
if (-not $status -or $status.BackendState -ne "Running") {
  $env:TS_AUTHKEY_TMP = $input.tsAuthKey
  $out = & $ts up --unattended=true --accept-routes --hostname=$input.tailnetName --authkey=$env:TS_AUTHKEY_TMP 2>&1
  Remove-Item Env:TS_AUTHKEY_TMP
  $status = & $ts status --json 2>$null | ConvertFrom-Json
  if (-not $status -or $status.BackendState -ne "Running") { "first-boot: tailscale-failed $out"; exit 3 }
}
# sshd stays reachable on the tailnet only once the NSG rule is gone; nothing to change here.

# 2. TightVNC service: loopback only, VncAuth, no HTTP viewer, no tray icon. The password is an MSI
#    property for this one call (TightVNC stores it DES-obfuscated in HKLM\SOFTWARE\TightVNC\Server).
if (-not (Get-Service tvnserver -ErrorAction SilentlyContinue)) {
  Install-Msi (Get-Pinned "tightvnc") @(
    "ADDLOCAL=Server", "SERVER_REGISTER_AS_SERVICE=1", "SERVER_ADD_FIREWALL_EXCEPTION=0",
    "SET_USEVNCAUTHENTICATION=1", "VALUE_OF_USEVNCAUTHENTICATION=1",
    "SET_PASSWORD=1", "VALUE_OF_PASSWORD=$($input.vncPassword)",
    "SET_LOOPBACKONLY=1", "VALUE_OF_LOOPBACKONLY=1", "SET_ALLOWLOOPBACK=1", "VALUE_OF_ALLOWLOOPBACK=1",
    "SET_ACCEPTHTTPCONNECTIONS=1", "VALUE_OF_ACCEPTHTTPCONNECTIONS=0",
    "SET_RUNCONTROLINTERFACE=1", "VALUE_OF_RUNCONTROLINTERFACE=0",
    "SET_REMOVEWALLPAPER=1", "VALUE_OF_REMOVEWALLPAPER=0", "SET_RFBPORT=1", "VALUE_OF_RFBPORT=5900")
}
Set-Content -Path "$opt\vnc-password.txt" -Value $input.vncPassword -NoNewline -Encoding ascii
icacls "$opt\vnc-password.txt" /inheritance:r /grant "vasudev:R" /grant "SYSTEM:F" | Out-Null

# 3. Node 26, MinGit, pnpm via corepack.
if (-not (Test-Path "C:\Program Files\nodejs\node.exe")) { Install-Msi (Get-Pinned "node") @() }
if (-not (Test-Path "$opt\git\cmd\git.exe")) { Expand-Archive (Get-Pinned "git") -DestinationPath "$opt\git" -Force }
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
foreach ($p in "C:\Program Files\nodejs", "$opt\git\cmd", "$opt\bin", "$opt\caddy") {
  if ($machinePath -notlike "*$p*") { $machinePath = "$machinePath;$p" }
}
[Environment]::SetEnvironmentVariable("Path", $machinePath, "Machine")
$env:Path = $machinePath
& "C:\Program Files\nodejs\corepack.cmd" enable --install-directory "$opt\bin" | Out-Null

# 4. Caddy as a startup scheduled task (Caddy has no Windows service mode of its own).
if (-not (Test-Path "$opt\caddy\caddy.exe")) { Expand-Archive (Get-Pinned "caddy") -DestinationPath "$opt\caddy" -Force }
$tailnetIp = (& $ts ip -4).Trim()
$bcrypt = (& "$opt\caddy\caddy.exe" hash-password --plaintext $input.frontPassword).Trim()
$caddyfile = @'
{{CADDYFILE_TMPL}}
'@
$caddyfile = $caddyfile.Replace("{{TAILNET_IP}}", $tailnetIp).Replace("{{OWNER_EMAIL}}", $input.ownerEmail).Replace("{{FRONT_PASSWORD_BCRYPT}}", $bcrypt)
Set-Content -Path "$opt\caddy\Caddyfile" -Value $caddyfile -Encoding ascii
& "$opt\caddy\caddy.exe" validate --config "$opt\caddy\Caddyfile" | Out-Null
if (-not (Get-ScheduledTask -TaskName "Vasudev Caddy" -ErrorAction SilentlyContinue)) {
  $action = New-ScheduledTaskAction -Execute "$opt\caddy\caddy.exe" -Argument "run --config $opt\caddy\Caddyfile" -WorkingDirectory "$opt\caddy"
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName "Vasudev Caddy" -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}
Start-ScheduledTask -TaskName "Vasudev Caddy"

# 5. Auto sign-in for vasudev (Sysinternals Autologon keeps the password as an LSA secret, not
#    plain text in the registry), no lock, no screen saver, foreground lock off.
if (-not (Test-Path "$opt\bin\Autologon64.exe")) { Expand-Archive (Get-Pinned "autologon") -DestinationPath "$opt\bin" -Force }
& "$opt\bin\Autologon64.exe" /accepteula vasudev $env:COMPUTERNAME $input.adminPassword | Out-Null
powercfg /change monitor-timeout-ac 0; powercfg /change standby-timeout-ac 0
$policies = @{
  "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" = @{ NoAutoUpdate = 0; AUOptions = 2; NoAutoRebootWithLoggedOnUsers = 1 }
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" = @{ DisableLockWorkstation = 1 }
  "HKCU:\Control Panel\Desktop" = @{ ScreenSaveActive = "0"; ForegroundLockTimeout = 0 }
}
foreach ($path in $policies.Keys) {
  New-Item -Path $path -Force | Out-Null
  foreach ($kv in $policies[$path].GetEnumerator()) { New-ItemProperty -Path $path -Name $kv.Key -Value $kv.Value -Force | Out-Null }
}

"first-boot: ok"
Restart-Computer -Force
```

`new-desk-azure.sh` substitutes `{{DOWNLOADS_JSON}}` and `{{CADDYFILE_TMPL}}` into a temp copy of the script before sending it (Task 4), so the script on the VM is self-contained.

- [ ] **Step 6: Run the tests**

Run: `node scripts/run-vitest.mjs run deploy/desk/windows/scripts.test.ts`
Expected: PASS (parse checks for both scripts, downloads shape).

- [ ] **Step 7: Commit**

```bash
git add deploy/desk/windows/first-boot.ps1 deploy/desk/windows/downloads.json deploy/desk/windows/Caddyfile.tmpl deploy/desk/windows/scripts.test.ts
git commit -m "feat(desk): Windows first boot — Tailscale, TightVNC, Caddy, Node, auto sign-in, policies

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `new-desk-azure.sh` phase 2 — first boot over SSH, close the operator rule, wait for the tailnet

**Files:**

- Modify: `deploy/desk/new-desk-azure.sh` (append after the SSH wait)
- Modify: `deploy/desk/scripts.test.ts` (three tests)

**Interfaces:**

- Consumes: `ssh_vm_script`, `azure_close_operator_ssh`, `desk_wait_for_tailnet_host`.
- Produces: `tailnet_host` (MagicDNS name) and `tailnet_ip` variables for phase 3; the operator rule is gone; `keep_operator_ssh=1` when the Tailscale join failed.

- [ ] **Step 1: Write the failing tests**

```ts
it("sends first-boot.ps1 with the env secrets on stdin, closes the operator SSH rule, and waits for the tailnet host", () => {
  const result = run(
    NEW_DESK_AZURE,
    [deskName, "--env-file", envFile, "--stop-after", "first-boot"],
    azureEnv({ SSH_STDOUT: "first-boot: ok" }),
  );
  expect(result.status, result.stderr).toBe(0);
  const sshCalls = readLog(sshLog);
  expect(sshCalls).toContain("-File C:\\opt\\stage\\first-boot.ps1");
  expect(sshCalls).not.toContain(TS_AUTHKEY_SECRET);
  expect(sshCalls).not.toContain("Fixture-Admin-Pass-1!");
  const stdinLog = readFileSync(join(dir, "ssh-stdin.log"), "utf8");
  expect(stdinLog).toContain(`"tsAuthKey":"${TS_AUTHKEY_SECRET}"`);
  expect(stdinLog).toContain('"tailnetName":"acme-az"');
  const log = readLog(azLog);
  expect(log).toContain("network nsg rule delete");
  expect(log.indexOf("nsg rule delete")).toBeGreaterThan(log.indexOf("vm create"));
  expect(result.stderr).toContain("acme-az.tailnet-fixture.ts.net");
});

it("keeps the operator SSH rule open and stops when the tailnet join fails", () => {
  const result = run(
    NEW_DESK_AZURE,
    [deskName, "--env-file", envFile, "--stop-after", "first-boot"],
    azureEnv({ SSH_STDOUT: "first-boot: tailscale-failed invalid key", SSH_EXIT_CODE: "3" }),
  );
  expect(result.status).toBe(3);
  expect(readLog(azLog)).not.toContain("network nsg rule delete");
  expect(result.stderr).toContain("tailscale-failed");
  expect(result.stderr).toContain("--resume");
});

it("closes the operator SSH rule when a later step fails", () => {
  const result = run(
    NEW_DESK_AZURE,
    [deskName, "--env-file", envFile, "--stop-after", "first-boot"],
    azureEnv({
      SSH_STDOUT: "first-boot: ok",
      TAILSCALE_STATUS_JSON: JSON.stringify({ MagicDNSSuffix: "x.ts.net.", Peer: {} }),
    }),
  );
  expect(result.status).not.toBe(0);
  expect(readLog(azLog)).toContain("network nsg rule delete");
});
```

The `ssh` stub extension from Task 2 (stdin log, `SSH_STDOUT` per call, `SSH_EXIT_CODE`) drives these.

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts -t "first-boot|operator SSH rule"`
Expected: FAIL — no `-File C:\opt\stage\first-boot.ps1` call; no `nsg rule delete`.

- [ ] **Step 3: Append phase 2**

```bash
# Phase 2: first boot over SSH. The script is sent self-contained (downloads.json and the Caddyfile
# template substituted in), the secrets go on stdin as one JSON document.
first_boot_script="$tmpdir/first-boot.ps1"
python3 - "$WINDOWS_DIR/first-boot.ps1" "$WINDOWS_DIR/downloads.json" "$WINDOWS_DIR/Caddyfile.tmpl" "$first_boot_script" <<'PY'
import sys
src, downloads, caddy, out = sys.argv[1:5]
text = open(src).read().replace("{{DOWNLOADS_JSON}}", open(downloads).read().strip()).replace("{{CADDYFILE_TMPL}}", open(caddy).read().strip())
open(out, "w").write(text)
PY
first_boot_json="$tmpdir/first-boot.json"; : > "$first_boot_json"; chmod 600 "$first_boot_json"
jq -cn --arg tailnetName "$tailnet_name" --arg tsAuthKey "$(env_get TS_AUTHKEY)" --arg adminPassword "$(env_get DESK_ADMIN_PASSWORD)" \
  --arg vncPassword "$vnc_password" --arg frontPassword "$(env_get DESK_FRONT_PASSWORD)" --arg ownerEmail "$owner_email" --arg gitRef "$git_ref" \
  '{tailnetName:$tailnetName, tsAuthKey:$tsAuthKey, adminPassword:$adminPassword, vncPassword:$vncPassword, frontPassword:$frontPassword, ownerEmail:$ownerEmail, gitRef:$gitRef}' > "$first_boot_json"
echo "==> First boot (Tailscale, TightVNC, Caddy, Node, auto sign-in); the VM reboots at the end" >&2
set +e
first_boot_out="$(ssh_vm_script "$public_ip" "$first_boot_script" "$first_boot_json")"
first_boot_status=$?
set -e
printf '%s\n' "$first_boot_out" | grep -v -i 'password\|authkey' >&2
if printf '%s' "$first_boot_out" | grep -q 'first-boot: tailscale-failed'; then
  keep_operator_ssh=1
  echo "new-desk-azure.sh: the VM could not join the tailnet (see above). SSH from ${operator_ip} to vasudev@${public_ip} stays open; fix TS_AUTHKEY in the env file and rerun with --resume" >&2
  exit 3
fi
# The reboot drops the SSH session, so a non-zero status with "first-boot: ok" in the output is success.
if ! printf '%s' "$first_boot_out" | grep -q 'first-boot: ok'; then
  echo "new-desk-azure.sh: first-boot.ps1 failed (exit ${first_boot_status})" >&2; exit 1
fi
echo "==> Closing the temporary operator SSH rule; everything else goes over the tailnet" >&2
azure_close_operator_ssh
echo "==> Waiting up to ${DESK_POLL_SECONDS}s for \"$tailnet_name\" on the tailnet" >&2
if ! tailnet_host="$(desk_wait_for_tailnet_host "$tailnet_name" "$DESK_POLL_SECONDS")"; then
  echo "new-desk-azure.sh: \"$tailnet_name\" did not appear on the tailnet — check \`tailscale status\` and the Tailscale admin console" >&2; exit 1
fi
tailnet_ip="$(tailscale status --json | jq -r --arg h "$tailnet_name" '.Peer[] | select((.HostName|ascii_downcase)==($h|ascii_downcase)) | .TailscaleIPs[0]')"
echo "==> ${tailnet_host} (${tailnet_ip})" >&2
if [[ "$stop_after" == "first-boot" ]]; then exit 0; fi
```

Note `--resume` after a tailscale failure: on rerun the VM exists, `azure_open_operator_ssh` recreates the rule (idempotent: `az network nsg rule create` on an existing name updates it), the run-command is harmless to repeat, and `first-boot.ps1` skips what is installed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts -t "new-desk-azure"`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
node_modules/.bin/oxfmt deploy/desk/scripts.test.ts
git add deploy/desk/new-desk-azure.sh deploy/desk/scripts.test.ts
git commit -m "feat(desk): Azure desk first boot over SSH; operator rule closed once the tailnet answers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Build on the Mac and push `dist/` + checkout to the VM with verification

**Files:**

- Create: `deploy/desk/windows/push-build.sh` (Mac side; also usable alone for later rolls)
- Create: `deploy/desk/windows/receive-build.ps1`
- Modify: `deploy/desk/scripts.test.ts` (one test for `push-build.sh` with the `ssh`/`tar`/`node` stubs)

**Interfaces:**

- Produces: `push-build.sh <tailnet-host> [--git-ref <sha>]` — ensures this checkout is at `<sha>` and has a `dist/` built from it (`dist/.provision-built-ref` equals the sha, else builds), tars `dist/` excluding `extensions/*/node_modules`, streams it over SSH to `receive-build.ps1`, which extracts to `C:\opt\openclaw\dist`, writes `dist\.provision-built-ref`, and compares a sha256 manifest. Prints `push-build: ok <sha> <file-count>`.

- [ ] **Step 1: Write the failing test**

```ts
describe("windows/push-build.sh", () => {
  it("refuses to push when dist was built from another commit, builds, then streams a tar and checks the manifest", () => {
    const result = run(PUSH_BUILD, ["acme-az.tailnet-fixture.ts.net", "--git-ref", "abc123"], {
      SSH_LOG: sshLog,
      SSH_STDOUT: "receive-build: ok 1234 files",
      DESK_BUILD_DIR: join(dir, "fake-dist"),
      GIT_STUB_HEAD: "abc123",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readLog(nodeLog)).toContain("pnpm build"); // the build ran because .provision-built-ref was absent
    expect(readLog(sshLog)).toContain("receive-build.ps1");
    expect(result.stdout).toContain("push-build: ok abc123");
  });
});
```

Create `join(dir, "fake-dist")` with one file in `beforeEach`. Add `const PUSH_BUILD = join(HERE, "windows", "push-build.sh");` and a `pnpm` stub that logs to `NODE_LOG` (reuse the `node` passthrough's log) and touches `dist/.provision-built-ref` with `GIT_STUB_HEAD`.

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts -t "push-build"`
Expected: FAIL — script not found.

- [ ] **Step 3: Write `push-build.sh`**

```bash
#!/usr/bin/env bash
# Pushes this checkout's runtime build to a Windows desk over SSH. dist/ is one unit (plugin bundles
# import hashed chunks from the parent dist; see office-pc-runbook.md §10.7), so the whole tree
# goes every time, excluding the per-plugin node_modules that `pnpm install` on the VM owns.
# Builds first when dist/.provision-built-ref is not the requested commit. A 2-vCPU VM should
# never run tsdown itself (4.3 GB heap, hours on the office PC).
set -euo pipefail
host="${1:?usage: push-build.sh <tailnet-host> [--git-ref <sha>]}"; shift
git_ref=""
while [[ $# -gt 0 ]]; do case "$1" in --git-ref) git_ref="$2"; shift 2 ;; *) echo "push-build.sh: unknown option $1" >&2; exit 2 ;; esac; done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$SCRIPT_DIR/../../.." && pwd)"
dist="${DESK_BUILD_DIR:-$repo/dist}"
git_ref="${git_ref:-$(git -C "$repo" rev-parse HEAD)}"
if [[ "$(git -C "$repo" rev-parse HEAD)" != "$git_ref" ]]; then
  echo "push-build.sh: this checkout is at $(git -C "$repo" rev-parse --short HEAD), not ${git_ref:0:11} — check out the commit to push first" >&2; exit 1
fi
if [[ ! -f "$dist/.provision-built-ref" || "$(cat "$dist/.provision-built-ref")" != "$git_ref" ]]; then
  echo "==> Building dist for ${git_ref:0:11}" >&2
  (cd "$repo" && OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352 pnpm build)
  printf '%s\n' "$git_ref" > "$dist/.provision-built-ref"
fi
manifest="$(cd "$dist" && find . -type f -not -path './extensions/*/node_modules/*' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
count="$(cd "$dist" && find . -type f -not -path './extensions/*/node_modules/*' | wc -l | tr -d ' ')"
receiver="$(iconv -f UTF-8 -t UTF-16LE "$SCRIPT_DIR/receive-build.ps1" | base64 | tr -d '\n')"
echo "==> Streaming ${count} files to ${host}" >&2
out="$(tar -C "$dist" --exclude='./extensions/*/node_modules' -cf - . \
  | ssh -o BatchMode=yes "vasudev@${host}" "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${receiver} -- ${git_ref} ${count} ${manifest}" | tr -d '\r')"
printf '%s\n' "$out" >&2
printf '%s' "$out" | grep -q '^receive-build: ok' || { echo "push-build.sh: the VM did not confirm the build" >&2; exit 1; }
echo "push-build: ok ${git_ref} ${count}"
```

`receive-build.ps1`:

```powershell
# Receives a tar of dist/ on stdin (from push-build.sh), extracts it to C:\opt\openclaw\dist, and
# confirms the file count and manifest hash the sender computed. Arguments after `--`: git sha,
# expected file count, expected manifest sha256.
param([string]$GitRef, [int]$ExpectedCount, [string]$ExpectedManifest)
$ErrorActionPreference = "Stop"
$dist = "C:\opt\openclaw\dist"; $tmp = "C:\opt\dist-incoming"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$stdin = [Console]::OpenStandardInput()
$tarPath = "$tmp.tar"
$fs = [IO.File]::Create($tarPath); $stdin.CopyTo($fs); $fs.Close()
tar.exe -xf $tarPath -C $tmp
Remove-Item $tarPath
$files = Get-ChildItem -Path $tmp -Recurse -File | Where-Object { $_.FullName -notmatch '\\extensions\\[^\\]+\\node_modules\\' }
if ($files.Count -ne $ExpectedCount) { "receive-build: count mismatch $($files.Count) != $ExpectedCount"; exit 1 }
$lines = $files | Sort-Object { $_.FullName.Substring($tmp.Length).Replace('\', '/') } -Culture "" | ForEach-Object {
  "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower())  ." + $_.FullName.Substring($tmp.Length).Replace('\', '/')
}
$manifest = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::ASCII.GetBytes(($lines -join "`n") + "`n"))).Replace('-', '').ToLower()
if ($manifest -ne $ExpectedManifest) { "receive-build: manifest mismatch $manifest != $ExpectedManifest"; exit 1 }
# Keep the plugin node_modules pnpm installed on the VM: swap everything else.
if (Test-Path $dist) {
  Get-ChildItem $dist | Where-Object Name -ne "extensions" | Remove-Item -Recurse -Force
  Get-ChildItem "$dist\extensions" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ChildItem $_.FullName | Where-Object Name -ne "node_modules" | Remove-Item -Recurse -Force
  }
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item -Path "$tmp\*" -Destination $dist -Recurse -Force
Remove-Item -Recurse -Force $tmp
Set-Content -Path "$dist\.provision-built-ref" -Value $GitRef -NoNewline -Encoding ascii
"receive-build: ok $($files.Count) files"
```

The manifest line format on both sides is `<sha256>  ./<path>` sorted bytewise, so the hashes agree when the trees agree. The sender's `find … | sort` uses `LC_ALL=C`; the receiver sorts with the invariant culture.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts deploy/desk/windows/scripts.test.ts -t "push-build|parses"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
chmod +x deploy/desk/windows/push-build.sh
git add deploy/desk/windows/push-build.sh deploy/desk/windows/receive-build.ps1 deploy/desk/scripts.test.ts
git commit -m "feat(desk): push the Mac-built dist to a Windows desk with a verified manifest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: `windows/provision-desk.ps1` + desk config template — checkout, config, Gateway task, Caddy check

**Files:**

- Create: `deploy/desk/windows/provision-desk.ps1`
- Create: `deploy/desk/windows/openclaw.windows-desk.json.tmpl`
- Modify: `deploy/desk/new-desk-azure.sh` (phase 3: push build, run provision, wait for the Gateway)
- Modify: `deploy/desk/scripts.test.ts` (one test), `deploy/desk/render-cloud-init.test.ts` is untouched

**Interfaces:**

- Consumes: JSON on stdin `{ "gitRef", "forkRepoUrl", "ownerEmail", "gatewayAdminPassword", "tailnetHost", "tailnetIp", "frontDoorOrigin": "https://vasudev.tripinstudio.com", "clientName": "acme" }`.
- Produces: `C:\opt\openclaw` at `gitRef` with `node_modules`, `%USERPROFILE%\.openclaw\openclaw.json` from the template, secrets under `C:\opt\secrets\` (ACL: vasudev + SYSTEM), Gateway scheduled task installed and running, `http://127.0.0.1:18789/healthz` answering, Caddy answering on `http://<tailnet-ip>:8443/healthz` with basic auth. Prints `provision-desk: ok`.

- [ ] **Step 1: Write the template**

`deploy/desk/windows/openclaw.windows-desk.json.tmpl` — the client template plus the trusted-proxy block the TripIn desk runs today (`office-pc-runbook.md` status block and §4), plus the node allowlist and the desktop host:

```json
{
  "gateway": {
    "mode": "local",
    "bind": "loopback",
    "tailscale": { "mode": "serve" },
    "controlUi": {
      "communityInvite": false,
      "allowedOrigins": ["{{FRONT_DOOR_ORIGIN}}", "https://{{TAILNET_HOST}}"]
    },
    "trustedProxies": ["127.0.0.1"],
    "auth": {
      "mode": "trusted-proxy",
      "trustedProxy": {
        "userHeader": "x-forwarded-user",
        "allowUsers": ["{{OWNER_EMAIL}}"],
        "allowLoopback": true,
        "allowTailscale": true
      },
      "identityScopes": {
        "{{OWNER_EMAIL}}": ["operator.admin"],
        "pulkitshah@github": ["operator.admin"]
      },
      "password": { "source": "file", "provider": "gateway-admin-password-file", "id": "value" }
    },
    "nodes": {
      "browser": { "mode": "auto" },
      "commands": { "allow": ["desktop.stream"] }
    }
  },
  "secrets": {
    "providers": {
      "gateway-admin-password-file": {
        "source": "file",
        "path": "C:\\opt\\secrets\\gateway-admin-password",
        "mode": "singleValue"
      }
    }
  },
  "desktop": {
    "host": { "enabled": true, "port": 5900, "passwordFile": "C:\\opt\\vnc-password.txt" }
  },
  "browser": { "ssrfPolicy": { "allowedHostnames": ["127.0.0.1"] } },
  "plugins": {
    "entries": {
      "anthropic": { "enabled": true, "config": { "sessionCatalog": { "enabled": false } } },
      "duties": { "enabled": true },
      "llm-task": { "enabled": true },
      "wallet": { "enabled": true },
      "cua-computer": { "enabled": true }
    }
  },
  "tools": { "alsoAllow": ["llm-task"] }
}
```

Before relying on it, diff the `gateway.auth`, `gateway.trustedProxies`, `gateway.controlUi` and `gateway.tailscale` keys against the live TripIn desk (`ssh root@tripin-studio 'jq .gateway /home/openclaw/.openclaw/openclaw.json'`, password key excluded) and copy any key the live desk has that this template lacks; record the diff in the runbook. The `identityScopes` values must match the live desk's exactly.

- [ ] **Step 2: Write `provision-desk.ps1`**

```powershell
# Provisions the Vasudev desk on a Windows VM that finished first-boot.ps1: fork checkout at the
# pinned commit, pnpm install (native platform packages), desk config from the template, secrets,
# the Gateway as the fork's managed scheduled task, and a Caddy round-trip. Runs over SSH as
# vasudev with a JSON document on stdin (gitRef, forkRepoUrl, ownerEmail, gatewayAdminPassword,
# tailnetHost, tailnetIp, frontDoorOrigin, clientName). dist/ arrives separately (push-build.sh).
$ErrorActionPreference = "Stop"
$input = [Console]::In.ReadToEnd() | ConvertFrom-Json
$root = "C:\opt\openclaw"; $secrets = "C:\opt\secrets"; $state = "$env:USERPROFILE\.openclaw"
New-Item -ItemType Directory -Force -Path $secrets, $state | Out-Null
icacls $secrets /inheritance:r /grant "vasudev:(OI)(CI)F" /grant "SYSTEM:(OI)(CI)F" | Out-Null

# 1. Checkout at the pinned commit (shallow; the build itself comes from the Mac).
if (-not (Test-Path "$root\package.json")) {
  git clone --depth 1 --no-checkout $input.forkRepoUrl $root
}
git -C $root fetch --depth 1 origin $input.gitRef
git -C $root checkout --detach FETCH_HEAD
git -C $root config core.autocrlf false

# 2. pnpm pinned by the checkout, then the runtime dependencies (native win32 packages included).
$pm = node -p "require('$($root.Replace('\','/'))/package.json').packageManager"
corepack prepare $pm --activate | Out-Null
Push-Location $root
$env:npm_config_minimum_release_age = "0"; $env:npm_config_minimum_release_age_strict = "false"; $env:npm_config_fetch_timeout = "900000"
pnpm install --frozen-lockfile --ignore-scripts
Pop-Location
if (-not (Test-Path "$root\dist\.provision-built-ref") -or (Get-Content "$root\dist\.provision-built-ref" -Raw).Trim() -ne $input.gitRef) {
  "provision-desk: dist is not built for $($input.gitRef) — run deploy/desk/windows/push-build.sh first"; exit 4
}

# 3. Secrets, then the config from the template.
Set-Content -Path "$secrets\gateway-admin-password" -Value $input.gatewayAdminPassword -NoNewline -Encoding ascii
$tmpl = @'
{{CONFIG_TMPL}}
'@
$config = $tmpl.Replace("{{OWNER_EMAIL}}", $input.ownerEmail).Replace("{{TAILNET_HOST}}", $input.tailnetHost).Replace("{{FRONT_DOOR_ORIGIN}}", $input.frontDoorOrigin)
Set-Content -Path "$state\openclaw.json" -Value $config -Encoding ascii
node "$root\dist\index.js" config validate 2>&1 | Out-Null   # exits non-zero on an invalid shape

# 4. Gateway as the managed scheduled task, then wait for it.
node "$root\dist\index.js" gateway install --force | Out-Null
$deadline = (Get-Date).AddMinutes(5)
do {
  Start-Sleep -Seconds 5
  try { $ok = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:18789/healthz" -TimeoutSec 5).StatusCode -eq 200 } catch { $ok = $false }
} until ($ok -or (Get-Date) -gt $deadline)
if (-not $ok) { "provision-desk: gateway did not answer /healthz in 5 minutes"; node "$root\dist\index.js" gateway status --json; exit 5 }

# 5. Caddy round-trip from this box with the front password: proves the basic-auth listener and
#    the trusted-proxy identity end to end (the WebSocket is what the front door needs; /healthz
#    through Caddy proves the listener and the upstream).
$pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($input.ownerEmail):$($input.frontPassword)"))
$resp = Invoke-WebRequest -UseBasicParsing -Uri "http://$($input.tailnetIp):8443/healthz" -Headers @{ Authorization = "Basic $pair" } -TimeoutSec 10
if ($resp.StatusCode -ne 200) { "provision-desk: caddy returned $($resp.StatusCode)"; exit 6 }
"provision-desk: ok"
```

(`frontPassword` is added to the stdin JSON for the round-trip; it is read, used once, never written.)

- [ ] **Step 3: Write the failing test and append phase 3 to `new-desk-azure.sh`**

Test:

```ts
it("pushes the build, provisions over the tailnet host, and waits for the Gateway", () => {
  const result = run(
    NEW_DESK_AZURE,
    [deskName, "--env-file", envFile, "--resume", "--skip-pairing"],
    azureEnv({
      AZ_VM_EXISTS: "1",
      SSH_STDOUT: "first-boot: ok\nreceive-build: ok 1 files\nprovision-desk: ok",
      CURL_HEALTHZ_OK: "1",
      DESK_BUILD_DIR: join(dir, "fake-dist"),
      GIT_STUB_HEAD: "abc123",
    }),
  );
  expect(result.status, result.stderr).toBe(0);
  const sshCalls = readLog(sshLog);
  expect(sshCalls).toContain("vasudev@acme-az.tailnet-fixture.ts.net");
  const stdin = readFileSync(join(dir, "ssh-stdin.log"), "utf8");
  expect(stdin).toContain('"gatewayAdminPassword":"fixture-gateway-admin"');
  expect(stdin).toContain('"frontDoorOrigin":"https://vasudev.tripinstudio.com"');
  expect(result.stdout).toContain("Control UI: https://vasudev.tripinstudio.com");
});
```

Phase 3 in the script (after the `stop_after == first-boot` exit):

```bash
# Phase 3: build + provision over the tailnet.
"$WINDOWS_DIR/push-build.sh" "$tailnet_host" --git-ref "$git_ref"
provision_script="$tmpdir/provision-desk.ps1"
python3 - "$WINDOWS_DIR/provision-desk.ps1" "$WINDOWS_DIR/openclaw.windows-desk.json.tmpl" "$provision_script" <<'PY'
import sys
src, tmpl, out = sys.argv[1:4]
open(out, "w").write(open(src).read().replace("{{CONFIG_TMPL}}", open(tmpl).read().strip()))
PY
provision_json="$tmpdir/provision.json"; : > "$provision_json"; chmod 600 "$provision_json"
fork_repo_url="${DESK_FORK_REPO_URL:-$(git -C "$SCRIPT_DIR" remote get-url origin)}"
front_door_origin="${DESK_FRONT_DOOR_ORIGIN:-https://vasudev.tripinstudio.com}"
jq -cn --arg gitRef "$git_ref" --arg forkRepoUrl "$fork_repo_url" --arg ownerEmail "$owner_email" \
  --arg gatewayAdminPassword "$(env_get GATEWAY_ADMIN_PASSWORD)" --arg frontPassword "$(env_get DESK_FRONT_PASSWORD)" \
  --arg tailnetHost "$tailnet_host" --arg tailnetIp "$tailnet_ip" --arg frontDoorOrigin "$front_door_origin" --arg clientName "$client" \
  '{gitRef:$gitRef, forkRepoUrl:$forkRepoUrl, ownerEmail:$ownerEmail, gatewayAdminPassword:$gatewayAdminPassword, frontPassword:$frontPassword, tailnetHost:$tailnetHost, tailnetIp:$tailnetIp, frontDoorOrigin:$frontDoorOrigin, clientName:$clientName}' > "$provision_json"
echo "==> Provisioning the desk (checkout, pnpm install, config, Gateway task)" >&2
provision_out="$(ssh_vm_script "$tailnet_host" "$provision_script" "$provision_json")"
printf '%s\n' "$provision_out" | grep -v -i 'password' >&2
printf '%s' "$provision_out" | grep -q '^provision-desk: ok' || { echo "new-desk-azure.sh: provision-desk.ps1 failed" >&2; exit 1; }
control_ui_url="$front_door_origin"
```

Add `--skip-pairing` (`skip_pairing=1`, test-only, documented under "testing" in `usage()`) to the option parser. The pairing phase (Task 7) follows; `--skip-pairing` ends the run here with the ready banner:

```bash
if (( skip_pairing == 1 )); then
  desk_print_ready "$desk_name" "$control_ui_url" "vasudev@${tailnet_host}" client; exit 0
fi
```

Note `desk_print_ready` prints a Linux-shaped sign-in hint; Task 8 adds a Windows-aware variant.

- [ ] **Step 4: Run the tests**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts deploy/desk/windows/scripts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add deploy/desk/windows/provision-desk.ps1 deploy/desk/windows/openclaw.windows-desk.json.tmpl deploy/desk/new-desk-azure.sh deploy/desk/scripts.test.ts
git commit -m "feat(desk): provision the Windows desk — checkout, trusted-proxy config, Gateway task

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Node pairing and approvals (`windows/pair-node.ps1`)

**Files:**

- Create: `deploy/desk/windows/pair-node.ps1`
- Modify: `deploy/desk/new-desk-azure.sh` (phase 4)
- Modify: `deploy/desk/scripts.test.ts` (one test)

**Interfaces:**

- Consumes: stdin JSON `{ "tailnetHost", "gatewayAdminPassword", "displayName": "Acme desktop" }`.
- Produces: the node installed as the "OpenClaw Node" logon task, paired, device and `desktop.stream` surface approved, `nodes status` listing `computer.act`, `screen.snapshot`, `desktop.stream`. Prints `pair-node: ok` or `pair-node: ingress-unreachable` (exit 7) when the ts.net URL does not answer from the box, so the operator can fall back to the loopback entrance documented in the runbook.

- [ ] **Step 1: Write the failing test**

```ts
it("pairs the node over the ts.net ingress and approves the device and the desktop.stream surface", () => {
  const result = run(
    NEW_DESK_AZURE,
    [deskName, "--env-file", envFile, "--resume"],
    azureEnv({
      AZ_VM_EXISTS: "1",
      SSH_STDOUT: "first-boot: ok\nreceive-build: ok 1 files\nprovision-desk: ok\npair-node: ok",
      CURL_HEALTHZ_OK: "1",
      DESK_BUILD_DIR: join(dir, "fake-dist"),
      GIT_STUB_HEAD: "abc123",
    }),
  );
  expect(result.status, result.stderr).toBe(0);
  const stdin = readFileSync(join(dir, "ssh-stdin.log"), "utf8");
  expect(stdin).toContain('"displayName":"acme desktop"');
  expect(result.stdout).toContain("Desktop node: acme desktop");
});
```

- [ ] **Step 2: Write `pair-node.ps1`**

```powershell
# Pairs this VM's own desktop node with the Gateway running on it, through the Gateway's managed
# Tailscale ingress (wss://<tailnet-host>), the same path every other node uses. Runs over SSH as
# vasudev in a non-interactive session; the node task itself starts at the next sign-in (auto
# sign-in reboots do that) and is started once here for the approvals. stdin JSON: tailnetHost,
# gatewayAdminPassword, displayName.
$ErrorActionPreference = "Stop"
$input = [Console]::In.ReadToEnd() | ConvertFrom-Json
$cli = "C:\opt\openclaw\dist\index.js"
$pw = $input.gatewayAdminPassword
$ingress = "https://$($input.tailnetHost)"
try { $null = Invoke-WebRequest -UseBasicParsing -Uri "$ingress/healthz" -TimeoutSec 10 } catch { "pair-node: ingress-unreachable $ingress"; exit 7 }

node $cli plugins enable cua-computer | Out-Null
$join = node $cli devices join-code --json --password $pw | ConvertFrom-Json
$payload = (Invoke-WebRequest -UseBasicParsing -Uri "$ingress/j/$($join.code)" -TimeoutSec 10).Content
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
node $cli node install --host $input.tailnetHost --port 443 --tls --display-name $input.displayName --force | Out-Null
# One foreground run to redeem the pairing, in the background so the approvals can happen.
$proc = Start-Process node -ArgumentList @($cli, "node", "run", "--pair", $b64, "--host", $input.tailnetHost, "--port", "443", "--tls", "--display-name", "`"$($input.displayName)`"") -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 15
$devices = node $cli devices list --json --password $pw | ConvertFrom-Json
foreach ($d in $devices.pending) { node $cli devices approve $d.requestId --password $pw | Out-Null }
Start-Sleep -Seconds 5
$pending = node $cli nodes pending --json --password $pw | ConvertFrom-Json
foreach ($p in $pending) { node $cli nodes approve $p.requestId --password $pw | Out-Null }
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "OpenClaw Node"
Start-Sleep -Seconds 20
$status = node $cli nodes status --json --password $pw | ConvertFrom-Json
$node = $status.nodes | Where-Object displayName -eq $input.displayName | Select-Object -First 1
$cmds = @($node.commands)
foreach ($c in "computer.act", "screen.snapshot", "desktop.stream") {
  if ($cmds -notcontains $c) { "pair-node: $c not advertised (have: $($cmds -join ','))"; exit 8 }
}
"pair-node: ok"
```

Verify the exact JSON field names (`pending[].requestId`, `nodes[].commands`, `nodes[].displayName`) against `node dist/index.js devices list --json` and `nodes status --json` on the TripIn desk before the live run; adjust the property names in this script to match, and note them in the runbook.

- [ ] **Step 3: Append phase 4 to `new-desk-azure.sh`**

```bash
pair_json="$tmpdir/pair.json"; : > "$pair_json"; chmod 600 "$pair_json"
display_name="${client} desktop"
jq -cn --arg tailnetHost "$tailnet_host" --arg gatewayAdminPassword "$(env_get GATEWAY_ADMIN_PASSWORD)" --arg displayName "$display_name" \
  '{tailnetHost:$tailnetHost, gatewayAdminPassword:$gatewayAdminPassword, displayName:$displayName}' > "$pair_json"
echo "==> Pairing the desktop node" >&2
set +e; pair_out="$(ssh_vm_script "$tailnet_host" "$WINDOWS_DIR/pair-node.ps1" "$pair_json")"; pair_status=$?; set -e
printf '%s\n' "$pair_out" | grep -v -i 'password' >&2
if (( pair_status == 7 )); then
  echo "new-desk-azure.sh: the Gateway's Tailscale ingress is not reachable from the VM itself — see windows-desk-runbook.md \"Loopback entrance fallback\"" >&2; exit 7
fi
printf '%s' "$pair_out" | grep -q '^pair-node: ok' || { echo "new-desk-azure.sh: pair-node.ps1 failed" >&2; exit 1; }
echo
echo "Desk \"$desk_name\" is up."
echo "Control UI: ${control_ui_url}   (front door; add the route — see windows-desk-runbook.md)"
echo "Desktop node: ${display_name}"
echo "SSH:        ssh vasudev@${tailnet_host}"
echo "Health:     ssh vasudev@${tailnet_host} 'powershell -File C:\\opt\\openclaw\\deploy\\desk\\windows\\desk-health.ps1'"
```

- [ ] **Step 4: Run the tests, commit**

Run: `node scripts/run-vitest.mjs run deploy/desk/scripts.test.ts deploy/desk/windows/scripts.test.ts`
Expected: PASS.

```bash
git add deploy/desk/windows/pair-node.ps1 deploy/desk/new-desk-azure.sh deploy/desk/scripts.test.ts
git commit -m "feat(desk): pair the Windows desk's own desktop node over the Tailscale ingress

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: `windows/desk-health.ps1` — acceptance checks

**Files:**

- Create: `deploy/desk/windows/desk-health.ps1`
- Test: parse check (existing), plus a `-WhatIf`-style dry run is not possible; the live proof is Task 11.

**Interfaces:**

- Produces: prints one JSON line `{"hosted":true,"at":<ms>,"gateway":bool,"node":bool,"nodeCommands":[...],"vnc":bool,"vncLoopbackOnly":bool,"console":bool,"consoleReason":"ok|no-session|locked","tailscale":bool,"routes":[...],"caddy":bool,"egress":{"<addr>":"<ip>"},"load":<pct>,"memFreeMb":<n>}` and exits 0 when every boolean is true, 1 otherwise. Takes `-GatewayAdminPassword` from the `GATEWAY_ADMIN_PASSWORD` env var or `C:\opt\secrets\gateway-admin-password`, and `-WhitelistAddresses a,b,c` optional.

- [ ] **Step 1: Write the script**

```powershell
# One health line for an Azure Windows desk (operator check; the Duties page's Desk card does not
# read it yet — follow-up). Every reading is taken before any verdict; the exit code is the
# conjunction of the booleans so the create script and the reboot test can gate on it.
param([string[]]$WhitelistAddresses = @())
$ErrorActionPreference = "Continue"
$cli = "C:\opt\openclaw\dist\index.js"
$pw = if ($env:GATEWAY_ADMIN_PASSWORD) { $env:GATEWAY_ADMIN_PASSWORD } else { (Get-Content "C:\opt\secrets\gateway-admin-password" -Raw).Trim() }
function Test-Http([string]$url, [hashtable]$headers = @{}) { try { (Invoke-WebRequest -UseBasicParsing -Uri $url -Headers $headers -TimeoutSec 5).StatusCode -eq 200 } catch { $false } }

$gateway = Test-Http "http://127.0.0.1:18789/healthz"
$status = try { node $cli nodes status --json --password $pw 2>$null | ConvertFrom-Json } catch { $null }
$node = $status.nodes | Where-Object { $_.connected } | Select-Object -First 1
$nodeCommands = @($node.commands)
$nodeOk = $null -ne $node -and ($nodeCommands -contains "computer.act") -and ($nodeCommands -contains "screen.snapshot") -and ($nodeCommands -contains "desktop.stream")
$vncListeners = Get-NetTCPConnection -State Listen -LocalPort 5900 -ErrorAction SilentlyContinue
$vnc = $vncListeners.Count -gt 0
$vncLoopbackOnly = $vnc -and (($vncListeners | Where-Object LocalAddress -ne "127.0.0.1").Count -eq 0)
$session = (query user 2>$null | Select-String "^\s*>?vasudev\s" | Select-Object -First 1)
$consoleReason = if (-not $session) { "no-session" } elseif ((Get-Process -Name LogonUI -ErrorAction SilentlyContinue)) { "locked" } else { "ok" }
$console = $consoleReason -eq "ok"
$ts = try { & "C:\Program Files\Tailscale\tailscale.exe" status --json 2>$null | ConvertFrom-Json } catch { $null }
$tailscale = $ts.BackendState -eq "Running"
$routes = @((Get-NetRoute -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -eq "Tailscale" -and $_.DestinationPrefix -like "*/32" }).DestinationPrefix)
$tailnetIp = (& "C:\Program Files\Tailscale\tailscale.exe" ip -4 2>$null).Trim()
$caddy = Test-Http "http://$tailnetIp:8443/healthz" @{ Authorization = "Basic invalid" } -or ((try { Invoke-WebRequest -UseBasicParsing -Uri "http://$tailnetIp:8443/healthz" -TimeoutSec 5 } catch { $_.Exception.Response.StatusCode.value__ }) -eq 401)
$egress = @{}
foreach ($a in $WhitelistAddresses) { $egress[$a] = try { (Invoke-WebRequest -UseBasicParsing -Uri "https://api.ipify.org" -TimeoutSec 8 -Proxy $null).Content } catch { "error" } }
$load = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$memFreeMb = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
$result = [ordered]@{ hosted = $true; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); gateway = $gateway; node = $nodeOk; nodeCommands = $nodeCommands; vnc = $vnc; vncLoopbackOnly = $vncLoopbackOnly; console = $console; consoleReason = $consoleReason; tailscale = $tailscale; routes = $routes; caddy = $caddy; egress = $egress; load = $load; memFreeMb = $memFreeMb }
$result | ConvertTo-Json -Compress -Depth 4
if ($gateway -and $nodeOk -and $vnc -and $vncLoopbackOnly -and $console -and $tailscale -and $caddy) { exit 0 } else { exit 1 }
```

The egress check through `api.ipify.org` reports the VM's default public IP; the per-address check that proves the Mac route is in Task 11 step 4 (a request _to_ a whitelisted address is only meaningful against that address's own service, so the acceptance test uses `tracert`/`Test-NetConnection -TraceRoute` to show the first hop is the Tailscale interface).

- [ ] **Step 2: Parse-check and commit**

Run: `node scripts/run-vitest.mjs run deploy/desk/windows/scripts.test.ts`
Expected: PASS.

```bash
git add deploy/desk/windows/desk-health.ps1
git commit -m "feat(desk): desk-health.ps1 for Windows desks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: README section, runbook skeleton, front-door reference route

**Files:**

- Modify: `deploy/desk/README.md` (new `## Azure Windows desk` section after `## Oracle Cloud desk`)
- Create: `deploy/desk/windows-desk-runbook.md`
- Modify: `deploy/desk/front-door/Caddyfile.vasudev-desk-1` (reference: the `@tripin` route comment gains the Azure target shape)

**Interfaces:**

- Produces: operator docs; the runbook's "Loopback entrance fallback" section that Task 7's exit 7 points to.

- [ ] **Step 1: README section**

````markdown
## Azure Windows desk

A desk whose Gateway _and_ desktop node run on one Windows Server VM, for clients whose work lives
in Windows applications (Tally, Travelport Galileo). Design:
`docs/superpowers/specs/2026-10-16-azure-windows-desk-design.md`; as-executed notes and the
fallbacks: `deploy/desk/windows-desk-runbook.md`.

Prerequisites on the Mac: `az` (Homebrew `azure-cli`, `az login --tenant <id>`; device-code login
is blocked by the tenant's security defaults), `tailscale` on the desk's tailnet, `jq`, `pwsh`
(for the script tests), and this checkout at the commit to deploy with a built `dist/`
(`push-build.sh` builds it when missing).

Per desk, a 0600 env file `~/cashew-secrets/<desk>.env` with `OWNER_EMAIL`, `TS_AUTHKEY`
(reusable off, 90 days), `DESK_ADMIN_PASSWORD` (the VM's `vasudev` account; Azure requires 12+
characters with three character classes), `GATEWAY_ADMIN_PASSWORD`, `DESK_FRONT_PASSWORD` (the
front door's basic auth to this desk), `VNC_PASSWORD` (6-8 characters), `WHITELIST_ADDRESSES`
(comma-separated, may be empty).

```bash
deploy/desk/new-desk-azure.sh vasudev-acme-az --env-file ~/cashew-secrets/acme-az.env --client acme
```
````

What it does, in order: resource group / VNet / NSG (no inbound rules), a temporary SSH rule for
this machine's public IP, the VM (B2as v2, Windows Server 2022 Datacenter Azure Edition, 128 GB),
OpenSSH through a run-command, `first-boot.ps1` over SSH (Tailscale unattended, TightVNC loopback
only, Caddy startup task, Node 26 + MinGit + pnpm, auto sign-in, update/lock policies, reboot),
removal of the SSH rule, `push-build.sh`, `provision-desk.ps1` (checkout, `pnpm install`, config
from `windows/openclaw.windows-desk.json.tmpl`, Gateway task), `pair-node.ps1` (the desktop node
over the Gateway's Tailscale ingress, approvals), then the ready banner. Rerun with `--resume`
after any failure once the VM exists; the script never deletes a VM.

Then: add the front-door route (`@<client> header X-Forwarded-User <email>` →
`http://<tailnet-ip>:8443` with `header_up Host` and the basic-auth header, above the 403; see
`front-door/Caddyfile.vasudev-desk-1`), run `desk-health.ps1` over SSH, and set the whitelisted
routes on the egress device (runbook, "Egress routes").

Rolling: `git checkout <sha>` here, `deploy/desk/windows/push-build.sh <tailnet-host>`, then over
SSH `node C:\opt\openclaw\dist\index.js gateway restart` and restart the "OpenClaw Node" task
(`office-pc-runbook.md` §10.7 explains why the whole `dist` goes every time).

````

- [ ] **Step 2: Runbook skeleton**

`deploy/desk/windows-desk-runbook.md` with these sections, each a short paragraph now and filled in as executed in Task 11:

```markdown
# Azure Windows desk runbook

Plan: `docs/superpowers/plans/2026-10-16-azure-windows-desk.md`. Spec: `docs/superpowers/specs/2026-10-16-azure-windows-desk-design.md`.

## Status
(as executed: dates, names, addresses — filled in by the live run)

## 1. Azure account and CLI
Free account → pay-as-you-go upgrade is required before Central India allows B/D sizes (trial
subscriptions are blocked there; South India is open but ~2× the price). `az login --tenant <id>`.

## 2. Env file
Keys and where each value is used (see README "Azure Windows desk").

## 3. Create
`new-desk-azure.sh` phases and what each prints; `--resume`; `--stop-after`.

## 4. Front door route
The `@<client>` matcher and `reverse_proxy` block; `users.json` entry; `caddy validate && systemctl reload caddy` on `vasudev-front-door`.

## 5. Loopback entrance fallback
If `pair-node.ps1` exits 7 (the Gateway's ts.net ingress does not answer from the VM itself), add
to `C:\opt\caddy\Caddyfile` the office-PC shape — a second listener `http://127.0.0.1:18790`
proxying to `127.0.0.1:18789` with `header_up X-Forwarded-User <owner email>` and
`header_up X-Forwarded-For <tailnet-ip>` — restart the "Vasudev Caddy" task, and pair with
`--host 127.0.0.1 --port 18790 --no-tls` (`office-pc-runbook.md` §10.3-10.4). Tradeoff: any
process on the VM reaches the desk as the owner; on a VM only the operator signs into, bounded.

## 6. Egress routes (stopgap until the portal feature)
On the Mac: `/Applications/Tailscale.app/Contents/MacOS/Tailscale set --advertise-routes=<a>/32,<b>/32`
with `sudo sysctl -w net.inet.ip.forwarding=1`; approve in the admin console (Machines → the Mac →
Edit route settings). The VM accepts routes (`--accept-routes` at join). Verify with
`Test-NetConnection <a> -TraceRoute` on the VM: first hop is the Tailscale interface.

## 7. Acceptance
`desk-health.ps1` output; the six checks from the spec §6 with their evidence.

## 8. Rolling, restarting, stopping
`push-build.sh`; `gateway restart`; node task restart; `az vm deallocate`/`start`.

## 9. Retiring the office PC desk
Steps and dates.
````

- [ ] **Step 3: Front-door reference**

In `deploy/desk/front-door/Caddyfile.vasudev-desk-1`, next to the `@tripin` route, add a comment block:

```
		# Azure Windows desks (deploy/desk/new-desk-azure.sh) use the same shape: the target is
		# http://<desk tailnet IP>:8443 (the desk's own Caddy, basic auth, plain HTTP over
		# WireGuard), with `header_up Host <ip>:8443` and the desk's basic-auth header. Never the
		# desk's ts.net name: that is the Gateway's managed-Tailscale ingress and rejects a
		# chained proxy.
```

- [ ] **Step 4: Docs checks and commit**

```bash
node_modules/.bin/oxfmt deploy/desk/README.md deploy/desk/windows-desk-runbook.md
git diff --check
git add deploy/desk/README.md deploy/desk/windows-desk-runbook.md deploy/desk/front-door/Caddyfile.vasudev-desk-1
git commit -m "docs(desk): Azure Windows desk — README section, runbook skeleton, front-door route note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Lanes, review, and the live create (paid)

**Files:**

- No new files. Runs the checks and the real deployment.

- [ ] **Step 1: Lanes and review**

```bash
node scripts/check-changed.mjs
```

Expected: all lanes green except the known brand-guard failure on `src/agents/bash-tools.exec-host-node.integration.test.ts` and `src/infra/exec-self-cli-deny.test.ts` (pre-existing, untouched). Then request a fresh code review of the branch (the `feature-dev:code-reviewer` agent, given the diff `git diff 71ec618ec00..HEAD`, not this plan) and resolve actionable findings with their own commits.

- [ ] **Step 2: Preconditions on the Mac**

- `az vm list-skus -l jioindiawest --size Standard_B2as_v2 --resource-type virtualMachines --query "[0].restrictions"` prints `[]` (verified 2026-10-16; Central India is still `NotAvailableForSubscription` after the upgrade). Owner 2026-10-16: "deploy at a costly instance if cheaper is not available" — not needed, Jio India West is the cheap price.
- `~/cashew-secrets/tripin-az.env` exists, mode 0600, all seven keys set (the owner supplies `TS_AUTHKEY`; generate the passwords with `openssl rand -base64 24` and the VNC one with `openssl rand -base64 6 | cut -c1-8`; record nothing in chat).
- This checkout is at the commit to deploy (`main` == `staging/team-v2-test`) and `pnpm build` output exists or will be built by `push-build.sh` (~10 minutes on the Mac).
- `tailscale status` shows the Mac online on `tail325f09.ts.net`.

- [ ] **Step 3: Create**

```bash
deploy/desk/new-desk-azure.sh vasudev-tripin-az --env-file ~/cashew-secrets/tripin-az.env --client tripin --location jioindiawest 2>&1 | tee ~/cashew-secrets/tripin-az-create.log
```

Watch for: `first-boot: ok` (then the reboot), the tailnet host `tripin-az.tail325f09.ts.net`, `receive-build: ok`, `provision-desk: ok`, `pair-node: ok`. On `pair-node: ingress-unreachable`, apply runbook §5 and rerun with `--resume`. Keep the log (it carries no secrets; the script filters password/authkey lines) as evidence in the runbook's Status block.

- [ ] **Step 4: Front door**

On `vasudev-front-door` (root over the tailnet): repoint `@tripin` from `http://100.95.17.69:8443` to `http://<tripin-az tailnet IP>:8443` (keep `header_up Host` and the basic-auth header, which now encodes `DESK_FRONT_PASSWORD` from the env file: `printf '%s:%s' "$OWNER_EMAIL" "$DESK_FRONT_PASSWORD" | base64`), `caddy validate --config /etc/caddy/Caddyfile`, `systemctl reload caddy`. Announce in chat before the switch: the office PC desk stops being served from that moment.

- [ ] **Step 5: Commit the as-executed runbook Status block**

Fill `windows-desk-runbook.md` "Status" with dates, names, the tailnet IP, the commit, and anything that deviated; commit as `docs(desk): Azure Windows desk — as executed`.

---

### Task 11: Acceptance (spec §6) and the egress stopgap

**Files:**

- Modify: `deploy/desk/windows-desk-runbook.md` (§6, §7 filled in)

- [ ] **Step 1: Front door login (spec 6.1)**

Owner signs in at `https://vasudev.tripinstudio.com`; the Devices page lists "tripin desktop" connected with `computer.act`, `screen.snapshot`, `desktop.stream`. Evidence: the owner's screenshot, sanitized, referenced in the runbook.

- [ ] **Step 2: Live screen (6.2)**

"Open desktop" on the Devices page shows the VM's console. Evidence: screenshot.

- [ ] **Step 3: Computer use (6.3, before Tally: Notepad)**

From the desk CLI over SSH, as the coordinator: `node C:\opt\openclaw\dist\index.js agent --agent coordinator -m "Take a screenshot, open Notepad from the Start menu, type 'Vasudev acceptance <date>', take a screenshot, close Notepad without saving" --json --password <from file>`; the run returns `ok` for each action with no `foregroundFallback` (the lock timeout is 0 on this account). Repeat with Tally once the owner has installed it (open Gateway of Tally → a named report → read a value).

- [ ] **Step 4: Egress (6.4)**

Mac: `sudo sysctl -w net.inet.ip.forwarding=1` and `/Applications/Tailscale.app/Contents/MacOS/Tailscale set --advertise-routes=<each WHITELIST_ADDRESSES>/32`; owner approves the routes in the admin console. VM: `Test-NetConnection <addr> -TraceRoute` shows the first hop on the Tailscale interface (100.x), and `tracert 1.1.1.1` shows Azure's gateway. Put the Mac to sleep: the whitelisted address times out, `https://api.ipify.org` still answers with Azure's IP. Record both in the runbook.

- [ ] **Step 5: Reboot (6.5)**

`az vm restart --resource-group vasudev --name vasudev-tripin-az`; within 5 minutes `ssh vasudev@tripin-az.tail325f09.ts.net 'powershell -File C:\opt\openclaw\deploy\desk\windows\desk-health.ps1'` exits 0 with `console: true`. If `consoleReason` is `no-session`, auto sign-in did not take: check `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon` `AutoAdminLogon = 1` and rerun `Autologon64.exe` from `first-boot.ps1` step 5 over SSH.

- [ ] **Step 6: Record and commit**

Runbook §7 gets the six results with timestamps; commit `docs(desk): Azure Windows desk — acceptance as executed`. Update memory `azure-windows-desk.md` and `tripin-studio-desk.md` (the office PC desk is now the fallback, retirement date set a week out).

---

### Task 12: Retire the office PC desk (one week after Task 11)

- [ ] **Step 1:** On the PC: `schtasks /change /tn "OpenClaw Node" /disable`, stop the node process (runbook §10.7 recipe), `systemctl disable --now openclaw-gateway` inside WSL (announce first), leave the distro for a week.
- [ ] **Step 2:** After the week with no owner objection: `wsl --unregister Ubuntu` is the owner's call on their own PC; remove `C:\opt\openclaw`, `C:\opt\cua-probe.mjs`, `C:\opt\fg.ps1`, `C:\opt\probe-args.json`, `C:\opt\run-in-session.*`, `C:\opt\cua-cursor-probe.mjs`, `C:\opt\cursor-*.png`, `C:\opt\cursor-probe.log`; delete the `tripin-studio` node in the Tailscale admin console; remove the front door's old target from the Caddyfile comments.
- [ ] **Step 3:** Memory: mark `tripin-studio-desk` retired with the date; `office-pc-runbook.md` gets a one-line banner pointing at the Windows desk runbook. Commit `docs(desk): office PC desk retired`.
