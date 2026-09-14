#!/usr/bin/env bash
# Creates one hosted desk: a DigitalOcean droplet running this fork's Gateway with the Duties
# plugin, reachable only over the owner's tailnet. See docs/superpowers/specs/2026-09-14-hosted-
# desk-design.md §3 (provisioning) and §10 (security). Run from the operator's Mac, with `doctl`
# authenticated and `tailscale` joined to the same tailnet the desk will join.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: new-desk.sh <desk-name> --ts-authkey-file <file> --tg-token-file <file> \
                    --owner-target <telegram-id> [--size s-2vcpu-4gb] [--git-ref <ref>] \
                    [--image <image-or-snapshot-id>] [--gateway-token-file <file>]

Creates one hosted desk droplet, waits for it to join the tailnet, and prints the Control UI
URL plus the first-sign-in command. Secrets (Tailscale auth key, Telegram bot token, and the
optional Gateway token) are read from files, never taken as arguments, and never printed —
the rendered cloud-init file that carries them is written 0600 to a mktemp path and deleted
on exit.

Required:
  <desk-name>                A DNS-safe hostname for the desk, e.g. desk-acme.
  --ts-authkey-file <file>   File holding a Tailscale pre-auth key (single line).
  --tg-token-file <file>     File holding the desk's Telegram bot token (single line).
  --owner-target <id>        Telegram user/chat id allowed to DM this desk's agent.

Optional:
  --size <slug>              doctl Droplet size slug (default: s-2vcpu-4gb).
  --git-ref <ref>            Fork ref to check out on first boot (default: main).
  --image <slug-or-id>       Base image or a prior desk's snapshot id (default: ubuntu-24-04-x64).
  --gateway-token-file <f>   Pre-chosen Gateway auth token; a random one is generated if omitted.

Environment overrides:
  DESK_SSH_KEY_NAME    doctl SSH key name to embed (default: "Pulkit Macbook Pro 2025")
  DESK_REGION          DigitalOcean region (default: blr1)
  DESK_TAG             droplet tag (default: desk)
  DESK_FIREWALL_NAME   cloud firewall name, created if missing (default: desk-no-inbound)
  DESK_POLL_SECONDS    seconds to wait for the tailnet hostname (default: 900)
EOF
}

DESK_SSH_KEY_NAME="${DESK_SSH_KEY_NAME:-Pulkit Macbook Pro 2025}"
DESK_REGION="${DESK_REGION:-blr1}"
DESK_TAG="${DESK_TAG:-desk}"
DESK_FIREWALL_NAME="${DESK_FIREWALL_NAME:-desk-no-inbound}"
DESK_POLL_SECONDS="${DESK_POLL_SECONDS:-900}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

desk_name=""
size="s-2vcpu-4gb"
git_ref="main"
image="ubuntu-24-04-x64"
ts_authkey_file=""
tg_token_file=""
owner_target=""
gateway_token_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --size)
      size="$2"
      shift 2
      ;;
    --git-ref)
      git_ref="$2"
      shift 2
      ;;
    --image)
      image="$2"
      shift 2
      ;;
    --ts-authkey-file)
      ts_authkey_file="$2"
      shift 2
      ;;
    --tg-token-file)
      tg_token_file="$2"
      shift 2
      ;;
    --owner-target)
      owner_target="$2"
      shift 2
      ;;
    --gateway-token-file)
      gateway_token_file="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "new-desk.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$desk_name" ]]; then
        echo "new-desk.sh: unexpected argument: $1" >&2
        exit 2
      fi
      desk_name="$1"
      shift
      ;;
  esac
done

if [[ -z "$desk_name" || -z "$ts_authkey_file" || -z "$tg_token_file" || -z "$owner_target" ]]; then
  usage >&2
  exit 2
fi

echo "==> Looking up doctl SSH key \"$DESK_SSH_KEY_NAME\"" >&2
ssh_key_id="$(
  doctl compute ssh-key list -o json \
    | jq -r --arg name "$DESK_SSH_KEY_NAME" '.[] | select(.name == $name) | .id' \
    | head -n1
)"
if [[ -z "$ssh_key_id" ]]; then
  echo "new-desk.sh: no doctl SSH key named \"$DESK_SSH_KEY_NAME\" — set DESK_SSH_KEY_NAME or add the key in the DigitalOcean control panel" >&2
  exit 1
fi

echo "==> Ensuring firewall \"$DESK_FIREWALL_NAME\" exists (no inbound, all outbound)" >&2
firewall_id="$(
  doctl compute firewall list -o json \
    | jq -r --arg name "$DESK_FIREWALL_NAME" '.[] | select(.name == $name) | .id' \
    | head -n1
)"
if [[ -z "$firewall_id" ]]; then
  echo "==> Creating firewall \"$DESK_FIREWALL_NAME\"" >&2
  firewall_id="$(
    doctl compute firewall create \
      --name "$DESK_FIREWALL_NAME" \
      --inbound-rules "" \
      --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0" \
      -o json \
      | jq -r 'if type == "array" then .[0].id else .id end'
  )"
fi
if [[ -z "$firewall_id" || "$firewall_id" == "null" ]]; then
  echo "new-desk.sh: could not determine the id of firewall \"$DESK_FIREWALL_NAME\"" >&2
  exit 1
fi

cloud_init_file="$(mktemp)"
chmod 600 "$cloud_init_file"
cleanup() {
  rm -f "$cloud_init_file"
}
trap cleanup EXIT

echo "==> Rendering cloud-init for \"$desk_name\" (git-ref $git_ref)" >&2
render_args=(
  --name "$desk_name"
  --ts-authkey-file "$ts_authkey_file"
  --tg-token-file "$tg_token_file"
  --owner-target "$owner_target"
  --git-ref "$git_ref"
)
if [[ -n "$gateway_token_file" ]]; then
  render_args+=(--gateway-token-file "$gateway_token_file")
fi
node "$SCRIPT_DIR/render-cloud-init.mjs" "${render_args[@]}" > "$cloud_init_file"

echo "==> Creating droplet \"$desk_name\" in $DESK_REGION ($size, $image)" >&2
droplet_id="$(
  doctl compute droplet create "$desk_name" \
    --region "$DESK_REGION" \
    --size "$size" \
    --image "$image" \
    --ssh-keys "$ssh_key_id" \
    --tag-names "$DESK_TAG" \
    --user-data-file "$cloud_init_file" \
    --wait \
    -o json \
    | jq -r 'if type == "array" then .[0].id else .id end'
)"
if [[ -z "$droplet_id" || "$droplet_id" == "null" ]]; then
  echo "new-desk.sh: doctl did not return a droplet id for \"$desk_name\"" >&2
  exit 1
fi

echo "==> Attaching droplet $droplet_id to firewall $firewall_id" >&2
doctl compute firewall add-droplets "$firewall_id" --droplet-ids "$droplet_id"

echo "==> Waiting up to ${DESK_POLL_SECONDS}s for \"$desk_name\" to join the tailnet" >&2
tailnet_host=""
poll_deadline=$((SECONDS + DESK_POLL_SECONDS))
tailnet_peer_filter='
  .MagicDNSSuffix as $suffix
  | (((.Peer // {}) | to_entries | map(.value)))[]
  | select((.HostName // "") | ascii_downcase == ($name | ascii_downcase))
  | select(.Online == true)
  | .HostName + "." + ($suffix // "" | rtrimstr("."))
'
while (( SECONDS < poll_deadline )); do
  status_json="$(tailscale status --json 2>/dev/null || true)"
  if [[ -n "$status_json" ]]; then
    tailnet_host="$(
      printf '%s' "$status_json" \
        | jq -r --arg name "$desk_name" "$tailnet_peer_filter" 2>/dev/null \
        | head -n1
    )"
  fi
  if [[ -n "$tailnet_host" ]]; then
    break
  fi
  sleep 10
done

if [[ -z "$tailnet_host" ]]; then
  echo "new-desk.sh: \"$desk_name\" did not appear on the tailnet within ${DESK_POLL_SECONDS}s — check \`tailscale status\` and the droplet's cloud-init log (\`ssh $desk_name 'cloud-init status --long'\` once it is reachable)" >&2
  exit 1
fi

echo
echo "Desk \"$desk_name\" is up."
echo "Control UI: https://${tailnet_host}"
echo "Sign in:    ssh ${desk_name} 'sudo -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'"
