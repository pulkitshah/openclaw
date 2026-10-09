#!/usr/bin/env bash
# Creates one hosted desk on Oracle Cloud (OCI): the same cloud-init recipe new-desk.sh boots on a
# DigitalOcean droplet, on an Always Free Ampere A1 (arm64) instance instead. Run from the
# operator's Mac with the `oci` CLI configured (~/.oci/config) and `tailscale` joined to the same
# tailnet the desk will join. See deploy/desk/README.md ("Oracle Cloud desk").
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: new-desk-oci.sh <desk-name> --ts-authkey-file <file> \
                        [--profile owner|client] [--tg-token-file <file>] \
                        [--owner-target <telegram-id>] [--ocpus 1] [--memory-gb 6] \
                        [--boot-gb 60] [--git-ref <ref>] [--gateway-token-file <file>] \
                        [--retry-minutes 1440] [--allow-paid]

Launches one desk on Oracle Cloud from the shared cloud-init recipe (render-cloud-init.mjs
--cloud oci), retrying while Oracle reports "Out of host capacity" (the normal state of the
Always Free A1 pool — a launch can take hours of retries), then waits for the desk to join the
tailnet and for its Gateway to answer, and prints the Control UI URL plus the first-sign-in
command. Secrets are read from files, never taken as arguments, and never printed; the rendered
cloud-init that carries them is written 0600 to a mktemp path and deleted on exit.

Required:
  <desk-name>                A DNS-safe hostname for the desk, e.g. desk-acme. Also the VNIC
                             hostname label and the instance display name.
  --ts-authkey-file <file>   File holding a Tailscale pre-auth key (single line).
  --tg-token-file <file>     Telegram bot token file. Required for --profile owner only.
  --owner-target <id>        Telegram user/chat id allowed to DM this desk's agent (owner only).

Optional:
  --profile <owner|client>   Whose desk this is (default: owner) — see new-desk.sh --help.
  --ocpus <n>                A1 cores (default: 1).      Always Free total: 2 OCPUs per tenancy.
  --memory-gb <n>            A1 memory (default: 6).     Always Free total: 12 GB per tenancy.
  --boot-gb <n>              Boot volume size (default: 60; Always Free total: 200 GB block).
  --allow-paid               Allow a shape above the Always Free allowance (billed by Oracle).
  --git-ref <ref>            Fork ref to check out on first boot (default: main).
  --gateway-token-file <f>   Pre-chosen Gateway auth token; a random one is generated if omitted.
  --retry-minutes <n>        How long to keep retrying a capacity-refused launch (default: 1440,
                             i.e. a day; one attempt every DESK_OCI_RETRY_SECONDS).

Environment overrides:
  OCI_CLI                    the oci executable (default: oci on PATH)
  DESK_OCI_COMPARTMENT_ID    compartment to launch in (default: the tenancy in ~/.oci/config)
  DESK_OCI_AVAILABILITY_DOMAIN  AD name (default: the tenancy's first AD)
  DESK_OCI_SUBNET_ID         public subnet id (default: the first subnet named
                             DESK_OCI_SUBNET_NAME, default "vasudev-public", in the compartment)
  DESK_OCI_IMAGE_ID          image id (default: newest Canonical Ubuntu 24.04 aarch64 image)
  DESK_OCI_RETRY_SECONDS     seconds between capacity-refused attempts (default: 300)
  DESK_SSH_PUBLIC_KEY        public key to embed (default: ~/.ssh/id_ed25519.pub, else id_rsa.pub)
  DESK_SSH_USER              account the printed sign-in command uses (default: root — the oci
                             cloud-init section copies the default user's key to root)
  DESK_POLL_SECONDS          seconds to wait for the tailnet hostname (default: 900)
  DESK_READY_POLL_SECONDS    seconds to wait for the Gateway to answer /healthz (default: 1800)
  DESK_FORK_REPO_URL         fork to clone on first boot (default: this checkout's `origin`)
EOF
}

OCI_CLI="${OCI_CLI:-oci}"
for cmd in "$OCI_CLI" jq tailscale curl ssh; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "new-desk-oci.sh: \"$cmd\" is required but not found on PATH — see deploy/desk/README.md (Oracle Cloud desk)" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/desk-wait.sh
source "$SCRIPT_DIR/lib/desk-wait.sh"

DESK_SSH_USER="${DESK_SSH_USER:-root}"
DESK_POLL_SECONDS="${DESK_POLL_SECONDS:-900}"
DESK_READY_POLL_SECONDS="${DESK_READY_POLL_SECONDS:-1800}"
DESK_READY_POLL_INTERVAL_SECONDS="${DESK_READY_POLL_INTERVAL_SECONDS:-10}"
DESK_OCI_RETRY_SECONDS="${DESK_OCI_RETRY_SECONDS:-300}"
DESK_OCI_SUBNET_NAME="${DESK_OCI_SUBNET_NAME:-vasudev-public}"

# Always Free Ampere A1 allowance per tenancy (Oracle, since 2026-08-18): 2 OCPUs and 12 GB in
# total across every A1 instance, and 200 GB of block storage. This is a per-launch sanity check
# only - it refuses one instance that alone exceeds the allowance, since on a Pay-As-You-Go tenancy
# that is silently billed. It does NOT sum what the tenancy already runs: the operator keeps the
# total in mind (two 1 OCPU / 6 GB desks fill it).
FREE_OCPUS=2
FREE_MEMORY_GB=12
FREE_BOOT_GB=200

desk_name=""
profile="owner"
ocpus=1
memory_gb=6
boot_gb=60
git_ref="main"
ts_authkey_file=""
tg_token_file=""
owner_target=""
gateway_token_file=""
retry_minutes=1440
allow_paid=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) profile="$2"; shift 2 ;;
    --ocpus) ocpus="$2"; shift 2 ;;
    --memory-gb) memory_gb="$2"; shift 2 ;;
    --boot-gb) boot_gb="$2"; shift 2 ;;
    --git-ref) git_ref="$2"; shift 2 ;;
    --ts-authkey-file) ts_authkey_file="$2"; shift 2 ;;
    --tg-token-file) tg_token_file="$2"; shift 2 ;;
    --owner-target) owner_target="$2"; shift 2 ;;
    --gateway-token-file) gateway_token_file="$2"; shift 2 ;;
    --retry-minutes) retry_minutes="$2"; shift 2 ;;
    --allow-paid) allow_paid=1; shift ;;
    -h | --help) usage; exit 0 ;;
    --) shift; break ;;
    -*)
      echo "new-desk-oci.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$desk_name" ]]; then
        echo "new-desk-oci.sh: unexpected argument: $1" >&2
        exit 2
      fi
      desk_name="$1"
      shift
      ;;
  esac
done

case "$profile" in
  owner | client) ;;
  *)
    echo "new-desk-oci.sh: --profile must be \"owner\" or \"client\", not \"$profile\"" >&2
    exit 2
    ;;
esac
if [[ -z "$desk_name" || -z "$ts_authkey_file" ]]; then
  usage >&2
  exit 2
fi
if [[ "$profile" == "owner" && ( -z "$tg_token_file" || -z "$owner_target" ) ]]; then
  usage >&2
  exit 2
fi
for n in "$ocpus" "$memory_gb" "$boot_gb" "$retry_minutes"; do
  if ! [[ "$n" =~ ^[0-9]+$ ]]; then
    echo "new-desk-oci.sh: --ocpus, --memory-gb, --boot-gb and --retry-minutes take whole numbers (got \"$n\")" >&2
    exit 2
  fi
done
if (( allow_paid == 0 )) && (( ocpus > FREE_OCPUS || memory_gb > FREE_MEMORY_GB )); then
  echo "new-desk-oci.sh: ${ocpus} OCPU / ${memory_gb} GB exceeds the Always Free A1 allowance (${FREE_OCPUS} OCPU / ${FREE_MEMORY_GB} GB per tenancy, shared by every A1 instance) — pass --allow-paid if Oracle billing is intended" >&2
  exit 2
fi
if (( allow_paid == 0 )) && (( boot_gb > FREE_BOOT_GB )); then
  echo "new-desk-oci.sh: a ${boot_gb} GB boot volume exceeds the Always Free block-storage allowance (${FREE_BOOT_GB} GB per tenancy, shared by every volume) — pass --allow-paid if Oracle billing is intended" >&2
  exit 2
fi

# The public key the instance embeds for its default user; the oci cloud-init section then copies
# it to root so `ssh root@<desk>` works from this machine like it does for a droplet.
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
  echo "new-desk-oci.sh: no SSH public key found — set DESK_SSH_PUBLIC_KEY to a .pub file whose private half lives on this machine" >&2
  exit 1
fi

# Where to launch. Each default is the obvious single answer for a one-region, one-compartment
# tenancy (the Always Free shape); an override is for anything else.
compartment_id="${DESK_OCI_COMPARTMENT_ID:-}"
if [[ -z "$compartment_id" ]]; then
  compartment_id="$(sed -n 's/^[[:space:]]*tenancy[[:space:]]*=[[:space:]]*//p' "${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}" | head -n1 | tr -d '[:space:]')"
fi
if [[ -z "$compartment_id" ]]; then
  echo "new-desk-oci.sh: set DESK_OCI_COMPARTMENT_ID — no tenancy found in ~/.oci/config" >&2
  exit 1
fi
availability_domain="${DESK_OCI_AVAILABILITY_DOMAIN:-}"
if [[ -z "$availability_domain" ]]; then
  echo "==> Looking up the availability domain" >&2
  availability_domain="$("$OCI_CLI" iam availability-domain list --compartment-id "$compartment_id" --output json | jq -r '.data[0].name // empty')"
fi
subnet_id="${DESK_OCI_SUBNET_ID:-}"
if [[ -z "$subnet_id" ]]; then
  echo "==> Looking up subnet \"$DESK_OCI_SUBNET_NAME\"" >&2
  # `oci ... list` prints NOTHING (not an empty array) when there is no match, hence the `|| true`
  # and the jq default: an empty subnet id is reported below instead of aborting on a parse error.
  subnet_id="$("$OCI_CLI" network subnet list --compartment-id "$compartment_id" --display-name "$DESK_OCI_SUBNET_NAME" --output json 2>/dev/null | jq -r '.data[0].id // empty' 2>/dev/null || true)"
fi
if [[ -z "$availability_domain" || -z "$subnet_id" ]]; then
  echo "new-desk-oci.sh: could not resolve the availability domain or the \"$DESK_OCI_SUBNET_NAME\" subnet — create the VCN first (README: Oracle Cloud desk) or set DESK_OCI_AVAILABILITY_DOMAIN / DESK_OCI_SUBNET_ID" >&2
  exit 1
fi
image_id="${DESK_OCI_IMAGE_ID:-}"
if [[ -z "$image_id" ]]; then
  echo "==> Looking up the newest Canonical Ubuntu 24.04 aarch64 image" >&2
  image_id="$("$OCI_CLI" compute image list --compartment-id "$compartment_id" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC --limit 1 --output json 2>/dev/null | jq -r '.data[0].id // empty' 2>/dev/null || true)"
fi
if [[ -z "$image_id" ]]; then
  echo "new-desk-oci.sh: no Ubuntu 24.04 aarch64 image found for VM.Standard.A1.Flex — set DESK_OCI_IMAGE_ID" >&2
  exit 1
fi

cloud_init_file="$(mktemp)"
chmod 600 "$cloud_init_file"
# Oracle caps instance metadata (the base64 of user-data plus the SSH key) at 32,000 bytes, and
# the rendered recipe is ~27 KB of mostly comments - over the cap once encoded (observed
# 2026-10-09: "Metadata size is 35551 bytes and cannot be larger than 32000 bytes"). cloud-init
# accepts gzip-compressed user-data, which brings it to roughly 13 KB encoded. Same 0600 + delete-on-exit
# handling: this copy carries the same secrets.
cloud_init_gz="$(mktemp)"
chmod 600 "$cloud_init_gz"
# oci prints the instance JSON on stdout and, with --wait-for-state, progress ("Action completed.
# Waiting until the resource has entered state: ...") and any CLI warnings on stderr; the two are
# kept apart so the JSON is parsed on its own and a successful launch is never mistaken for a
# failure because of a stderr line.
launch_out="$(mktemp)"
launch_err="$(mktemp)"
cleanup() {
  rm -f "$cloud_init_file" "$cloud_init_gz" "$launch_out" "$launch_err"
}
trap cleanup EXIT

echo "==> Rendering cloud-init for \"$desk_name\" ($profile profile, oci host, git-ref $git_ref)" >&2
render_args=(
  --name "$desk_name"
  --profile "$profile"
  --cloud oci
  --ts-authkey-file "$ts_authkey_file"
  --git-ref "$git_ref"
)
if [[ -n "$tg_token_file" ]]; then
  render_args+=(--tg-token-file "$tg_token_file")
fi
if [[ -n "$owner_target" ]]; then
  render_args+=(--owner-target "$owner_target")
fi
if [[ -n "$gateway_token_file" ]]; then
  render_args+=(--gateway-token-file "$gateway_token_file")
fi
node "$SCRIPT_DIR/render-cloud-init.mjs" "${render_args[@]}" > "$cloud_init_file"
gzip -9 -n -c "$cloud_init_file" > "$cloud_init_gz"

shape_config="$(jq -cn --argjson ocpus "$ocpus" --argjson mem "$memory_gb" '{ocpus: $ocpus, memoryInGBs: $mem}')"
echo "==> Launching \"$desk_name\" in $availability_domain (VM.Standard.A1.Flex ${ocpus} OCPU / ${memory_gb} GB, ${boot_gb} GB boot), retrying capacity refusals for up to ${retry_minutes} minutes" >&2
instance_id=""
launch_deadline=$((SECONDS + retry_minutes * 60))
attempt=0
while :; do
  attempt=$((attempt + 1))
  if "$OCI_CLI" compute instance launch \
    --compartment-id "$compartment_id" \
    --availability-domain "$availability_domain" \
    --shape VM.Standard.A1.Flex \
    --shape-config "$shape_config" \
    --image-id "$image_id" \
    --subnet-id "$subnet_id" \
    --assign-public-ip true \
    --display-name "$desk_name" \
    --hostname-label "$desk_name" \
    --ssh-authorized-keys-file "$ssh_public_key" \
    --user-data-file "$cloud_init_gz" \
    --boot-volume-size-in-gbs "$boot_gb" \
    --wait-for-state RUNNING \
    --output json > "$launch_out" 2> "$launch_err"; then
    instance_id="$(jq -r '.data.id // empty' "$launch_out" 2>/dev/null || true)"
    if [[ -n "$instance_id" ]]; then
      break
    fi
    echo "new-desk-oci.sh: oci returned success without an instance id — check the Oracle console for a stray \"$desk_name\" instance before retrying:" >&2
    cat "$launch_out" "$launch_err" >&2
    exit 1
  fi
  # Everything Oracle can say that is worth a retry: no A1 hosts free right now (the usual case),
  # or the per-user request throttle. Anything else is a real error and stops here.
  if grep -q 'Out of host capacity\|TooManyRequests\|InternalError' "$launch_out" "$launch_err"; then
    if (( SECONDS >= launch_deadline )); then
      echo "new-desk-oci.sh: gave up after ${attempt} attempts over ${retry_minutes} minutes — Oracle kept reporting no A1 capacity. Retry later (a Pay-As-You-Go upgrade improves the odds; the Always Free limits still apply)." >&2
      exit 1
    fi
    echo "==> attempt ${attempt}: $(grep -h -o '"message": "[^"]*"' "$launch_out" "$launch_err" | head -n1 | cut -d'"' -f4) ($(date +%H:%M)); next try in ${DESK_OCI_RETRY_SECONDS}s" >&2
    sleep "$DESK_OCI_RETRY_SECONDS"
    continue
  fi
  echo "new-desk-oci.sh: launch failed (if the wait timed out, check the Oracle console for a \"$desk_name\" instance before retrying):" >&2
  cat "$launch_out" "$launch_err" >&2
  exit 1
done

echo "==> Instance ${instance_id} is RUNNING; cloud-init is provisioning it" >&2
# Best effort: the public IP is informational (the desk is reached over the tailnet), so a failed
# lookup must not abandon an instance that already exists.
public_ip="$("$OCI_CLI" compute instance list-vnics --instance-id "$instance_id" --output json 2>/dev/null | jq -r '.data[0]."public-ip" // empty' 2>/dev/null || true)"
echo "==> Public IP: ${public_ip:-unknown}" >&2

echo "==> Waiting up to ${DESK_POLL_SECONDS}s for \"$desk_name\" to join the tailnet" >&2
if ! tailnet_host="$(desk_wait_for_tailnet_host "$desk_name" "$DESK_POLL_SECONDS")"; then
  echo "new-desk-oci.sh: \"$desk_name\" did not appear on the tailnet within ${DESK_POLL_SECONDS}s — check \`tailscale status\` and the instance's cloud-init log (\`ssh ubuntu@${public_ip:-<public-ip>} 'sudo cloud-init status --long'\`)" >&2
  exit 1
fi

control_ui_url="https://${tailnet_host}"
echo "==> Waiting up to ${DESK_READY_POLL_SECONDS}s for the Gateway at ${control_ui_url} to answer (checkout, install, build, Chromium, reboot — typically 15-25 minutes; longer on one A1 core)" >&2
if ! desk_wait_for_gateway "$desk_name" "$control_ui_url" "$DESK_READY_POLL_SECONDS" "$DESK_READY_POLL_INTERVAL_SECONDS"; then
  echo "new-desk-oci.sh: \"$desk_name\" joined the tailnet but its Gateway never answered ${control_ui_url}/healthz within ${DESK_READY_POLL_SECONDS}s — check \`ssh ${DESK_SSH_USER}@${desk_name} journalctl -u openclaw-gateway -u cloud-init-output --no-pager\`" >&2
  exit 4
fi

ssh_target="${DESK_SSH_USER}@${desk_name}"
desk_warn_if_provision_failed "$ssh_target" "$desk_name"
desk_print_ready "$desk_name" "$control_ui_url" "$ssh_target" "$profile"
echo "Public IP:  ${public_ip:-unknown}  (the desk's own Caddy, if any, goes on ${public_ip//./-}.sslip.io)"
