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
continue a run that stopped after the VM existed. The script never deletes a VM.

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

Testing only:
  --skip-first-boot    Stop after the OpenSSH bootstrap and the SSH wait.
  --skip-pairing       Stop after provisioning, before the desktop node is paired.

Environment overrides:
  AZ_CLI                   the az executable (default: az)
  DESK_AZ_RESOURCE_GROUP   (default: vasudev)       DESK_AZ_VNET (default: vasudev)
  DESK_AZ_SUBNET           (default: desks)         DESK_AZ_NSG  (default: vasudev-desks)
  DESK_OPERATOR_IP         public IP allowed to SSH during first boot (default: api.ipify.org)
  DESK_SSH_PUBLIC_KEY      public key for the vasudev account (default: ~/.ssh/id_ed25519.pub)
  DESK_SSH_WAIT_SECONDS    wait for SSH on the public IP (default: 600)
  DESK_POLL_SECONDS        wait for the tailnet hostname (default: 900)
  DESK_READY_POLL_SECONDS  wait for the Gateway /healthz (default: 1800)
  DESK_FORK_REPO_URL       fork to clone on the VM (default: this checkout's `origin`)
  DESK_FRONT_DOOR_ORIGIN   Control UI origin (default: https://vasudev.tripinstudio.com)
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

desk_name=""
env_file=""
client=""
git_ref=""
size="Standard_B2as_v2"
location="centralindia"
os_disk_gb=128
resume=0
stop_after=""
skip_first_boot=0
skip_pairing=0
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
    --skip-first-boot) skip_first_boot=1; shift ;;
    --skip-pairing) skip_pairing=1; shift ;;
    -h | --help) usage; exit 0 ;;
    -*)
      echo "new-desk-azure.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$desk_name" ]]; then
        echo "new-desk-azure.sh: unexpected argument: $1" >&2
        exit 2
      fi
      desk_name="$1"
      shift
      ;;
  esac
done
if [[ -z "$desk_name" || -z "$env_file" ]]; then
  usage >&2
  exit 2
fi
if ! [[ "$desk_name" =~ ^[a-z0-9-]{3,40}$ ]]; then
  echo "new-desk-azure.sh: desk-name must be lowercase letters, digits and dashes (got \"$desk_name\")" >&2
  exit 2
fi
case "$stop_after" in
  "" | create | first-boot) ;;
  *)
    echo "new-desk-azure.sh: --stop-after takes create or first-boot" >&2
    exit 2
    ;;
esac
if ! [[ "$os_disk_gb" =~ ^[0-9]+$ ]]; then
  echo "new-desk-azure.sh: --os-disk-gb takes a whole number (got \"$os_disk_gb\")" >&2
  exit 2
fi
tailnet_name="${desk_name#vasudev-}"
client="${client:-${tailnet_name%-az}}"
git_ref="${git_ref:-$(git -C "$SCRIPT_DIR" rev-parse HEAD)}"

# The env file is the only place secrets live on this side. Values are read one key at a time
# with sed, never sourced, so nothing from it reaches this process's environment or a child's
# argv. It must be private: a readable env file is the whole desk's keys in one place.
if [[ ! -f "$env_file" ]]; then
  echo "new-desk-azure.sh: env file not found: $env_file" >&2
  exit 2
fi
env_mode="$(stat -f '%Lp' "$env_file" 2>/dev/null || stat -c '%a' "$env_file")"
if [[ "$env_mode" != "600" && "$env_mode" != "400" ]]; then
  echo "new-desk-azure.sh: $env_file must be mode 0600 (is $env_mode)" >&2
  exit 2
fi
for key in OWNER_EMAIL TS_AUTHKEY DESK_ADMIN_PASSWORD GATEWAY_ADMIN_PASSWORD DESK_FRONT_PASSWORD VNC_PASSWORD WHITELIST_ADDRESSES; do
  if ! grep -q "^${key}=" "$env_file"; then
    echo "new-desk-azure.sh: $env_file is missing ${key}=" >&2
    exit 2
  fi
done
env_get() { sed -n "s/^$1=//p" "$env_file" | head -n1; }
owner_email="$(env_get OWNER_EMAIL)"
vnc_password="$(env_get VNC_PASSWORD)"
if (( ${#vnc_password} < 6 || ${#vnc_password} > 8 )); then
  echo "new-desk-azure.sh: VNC_PASSWORD must be 6-8 characters (TightVNC uses the first 8)" >&2
  exit 2
fi

ssh_public_key="${DESK_SSH_PUBLIC_KEY:-}"
if [[ -z "$ssh_public_key" ]]; then
  for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [[ -f "$candidate" ]]; then
      ssh_public_key="$candidate"
      break
    fi
  done
fi
if [[ -z "$ssh_public_key" || ! -f "$ssh_public_key" ]]; then
  echo "new-desk-azure.sh: no SSH public key found — set DESK_SSH_PUBLIC_KEY to a .pub file whose private half lives on this machine" >&2
  exit 1
fi
operator_ip="${DESK_OPERATOR_IP:-$(curl -fsS --max-time 10 https://api.ipify.org)}"
if ! [[ "$operator_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "new-desk-azure.sh: could not determine this machine's public IPv4 — set DESK_OPERATOR_IP" >&2
  exit 1
fi

"$AZ_CLI" account show --output json >/dev/null || {
  echo "new-desk-azure.sh: run \`az login\` first" >&2
  exit 1
}

# Temporary files carry secrets for az (@file arguments) and the SSH payloads; 0600 and deleted on
# exit. The operator SSH rule is closed on exit too, but only once the VM exists and first boot
# has not failed on the Tailscale join (the operator needs SSH to fix that).
tmpdir="$(mktemp -d)"
chmod 700 "$tmpdir"
vm_exists=0
keep_operator_ssh=0
azure_close_operator_ssh() {
  "$AZ_CLI" network nsg rule delete --resource-group "$DESK_AZ_RESOURCE_GROUP" --nsg-name "$DESK_AZ_NSG" --name "$OPERATOR_RULE_NAME" --output none 2>/dev/null || true
}
cleanup() {
  local status=$?
  if (( vm_exists == 1 && keep_operator_ssh == 0 )); then
    azure_close_operator_ssh
  fi
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
    echo "new-desk-azure.sh: VM \"$desk_name\" already exists — rerun with --resume to continue provisioning it" >&2
    exit 1
  fi
  vm_exists=1
  echo "==> VM $desk_name exists; resuming" >&2
else
  # az reads an argument from a file when the value is @<path>, so the password never sits in
  # argv; the file is 0600 inside the 0700 tmpdir and deleted on exit.
  admin_password_file="$tmpdir/admin-password"
  : > "$admin_password_file"
  chmod 600 "$admin_password_file"
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

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts_vasudev_desks")
# Runs one PowerShell command on the VM. Output comes back as-is (CRLF stripped).
ssh_vm() {
  local host="$1"
  shift
  ssh "${ssh_opts[@]}" "vasudev@${host}" "$@" | tr -d '\r'
}
# Runs a local .ps1 on the VM. Two SSH calls: the script body is written to C:\opt\stage\<name>
# from stdin (no command-line length limit, no quoting), then executed with the JSON parameters on
# stdin, so no secret is ever in argv or in a file on the VM.
ssh_vm_script() {
  local host="$1" script="$2" json_file="$3"
  local name
  name="$(basename "$script")"
  ssh "${ssh_opts[@]}" "vasudev@${host}" "powershell.exe -NoProfile -NonInteractive -Command \"New-Item -ItemType Directory -Force -Path C:\\opt\\stage | Out-Null; [IO.File]::WriteAllText('C:\\opt\\stage\\${name}', [Console]::In.ReadToEnd())\"" < "$script"
  ssh "${ssh_opts[@]}" "vasudev@${host}" "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\opt\\stage\\${name}" < "$json_file" | tr -d '\r'
}

echo "==> Bootstrapping OpenSSH on the VM (run-command, no secrets)" >&2
"$AZ_CLI" vm run-command invoke --resource-group "$DESK_AZ_RESOURCE_GROUP" --name "$desk_name" \
  --command-id RunPowerShellScript --scripts "@${WINDOWS_DIR}/bootstrap-ssh.ps1" \
  --parameters "PublicKey=$(cat "$ssh_public_key")" --output json > "$tmpdir/bootstrap.json"
if ! jq -e '.value[]?.message | select(contains("bootstrap-ssh: ok"))' "$tmpdir/bootstrap.json" >/dev/null; then
  echo "new-desk-azure.sh: bootstrap-ssh.ps1 did not report ok:" >&2
  jq -r '.value[]?.message' "$tmpdir/bootstrap.json" >&2
  exit 1
fi
echo "==> Waiting up to ${DESK_SSH_WAIT_SECONDS}s for SSH at ${public_ip}" >&2
ssh_deadline=$((SECONDS + DESK_SSH_WAIT_SECONDS))
until ssh_vm "$public_ip" 'Write-Output ready' 2>/dev/null | grep -q '^ready$'; do
  if (( SECONDS >= ssh_deadline )); then
    echo "new-desk-azure.sh: SSH to vasudev@${public_ip} never answered — check the NSG rule and \`az vm run-command invoke\` output" >&2
    exit 1
  fi
  sleep 10
done
if (( skip_first_boot == 1 )); then
  exit 0
fi

# Phase 2: first boot over SSH. The script is sent self-contained (downloads.json and the Caddyfile
# template substituted in), the secrets go on stdin as one JSON document.
first_boot_script="$tmpdir/first-boot.ps1"
python3 - "$WINDOWS_DIR/first-boot.ps1" "$WINDOWS_DIR/downloads.json" "$WINDOWS_DIR/Caddyfile.tmpl" "$first_boot_script" <<'PY'
import sys
src, downloads, caddy, out = sys.argv[1:5]
text = open(src).read().replace("{{DOWNLOADS_JSON}}", open(downloads).read().strip()).replace("{{CADDYFILE_TMPL}}", open(caddy).read().strip())
open(out, "w").write(text)
PY
first_boot_json="$tmpdir/first-boot.json"
: > "$first_boot_json"
chmod 600 "$first_boot_json"
jq -cn --arg tailnetName "$tailnet_name" --arg tsAuthKey "$(env_get TS_AUTHKEY)" --arg adminPassword "$(env_get DESK_ADMIN_PASSWORD)" \
  --arg vncPassword "$vnc_password" --arg frontPassword "$(env_get DESK_FRONT_PASSWORD)" --arg ownerEmail "$owner_email" --arg gitRef "$git_ref" \
  '{tailnetName:$tailnetName, tsAuthKey:$tsAuthKey, adminPassword:$adminPassword, vncPassword:$vncPassword, frontPassword:$frontPassword, ownerEmail:$ownerEmail, gitRef:$gitRef}' > "$first_boot_json"
echo "==> First boot (Tailscale, TightVNC, Caddy, Node, auto sign-in); the VM reboots at the end" >&2
set +e
first_boot_out="$(ssh_vm_script "$public_ip" "$first_boot_script" "$first_boot_json")"
first_boot_status=$?
set -e
printf '%s\n' "$first_boot_out" | grep -v -i 'password\|authkey' >&2 || true
if printf '%s' "$first_boot_out" | grep -q 'first-boot: tailscale-failed'; then
  keep_operator_ssh=1
  echo "new-desk-azure.sh: the VM could not join the tailnet (see above). SSH from ${operator_ip} to vasudev@${public_ip} stays open; fix TS_AUTHKEY in the env file and rerun with --resume" >&2
  exit 3
fi
# The reboot drops the SSH session, so a non-zero status with "first-boot: ok" in the output is success.
if ! printf '%s' "$first_boot_out" | grep -q 'first-boot: ok'; then
  echo "new-desk-azure.sh: first-boot.ps1 failed (exit ${first_boot_status})" >&2
  exit 1
fi
echo "==> Closing the temporary operator SSH rule; everything else goes over the tailnet" >&2
azure_close_operator_ssh
echo "==> Waiting up to ${DESK_POLL_SECONDS}s for \"$tailnet_name\" on the tailnet" >&2
if ! tailnet_host="$(desk_wait_for_tailnet_host "$tailnet_name" "$DESK_POLL_SECONDS")"; then
  echo "new-desk-azure.sh: \"$tailnet_name\" did not appear on the tailnet — check \`tailscale status\` and the Tailscale admin console" >&2
  exit 1
fi
tailnet_ip="$(tailscale status --json | jq -r --arg h "$tailnet_name" '[.Peer[] | select((.HostName | ascii_downcase) == ($h | ascii_downcase)) | .TailscaleIPs[0]] | first // empty')"
echo "==> ${tailnet_host} (${tailnet_ip})" >&2
if [[ "$stop_after" == "first-boot" ]]; then
  exit 0
fi
