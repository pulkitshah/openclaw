#!/usr/bin/env bash
# Creates one hosted desk: a DigitalOcean droplet running this fork's Gateway with the Duties
# plugin, reachable only over the owner's tailnet. See docs/superpowers/specs/2026-09-14-hosted-
# desk-design.md §3 (provisioning) and §10 (security). Run from the operator's Mac, with `doctl`
# authenticated and `tailscale` joined to the same tailnet the desk will join.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: new-desk.sh <desk-name> --ts-authkey-file <file> \
                    [--profile owner|client] [--tg-token-file <file>] \
                    [--owner-target <telegram-id>] [--size s-2vcpu-4gb] [--git-ref <ref>] \
                    [--image <image-or-snapshot-id>] [--gateway-token-file <file>]

Creates one hosted desk droplet, waits for it to join the tailnet, and prints the Control UI
URL plus the first-sign-in command. Secrets (Tailscale auth key, Telegram bot token, and the
optional Gateway token) are read from files, never taken as arguments, and never printed —
the rendered cloud-init file that carries them is written 0600 to a mktemp path and deleted
on exit.

Required:
  <desk-name>                A DNS-safe hostname for the desk, e.g. desk-acme.
  --ts-authkey-file <file>   File holding a Tailscale pre-auth key (single line).
                             Optional when TAILSCALE_AUTHKEY is set in the repo's
                             gitignored .env; that value is used automatically.
  --tg-token-file <file>     File holding the desk's Telegram bot token (single line).
                             Required for --profile owner; unused for --profile client.
  --owner-target <id>        Telegram user/chat id allowed to DM this desk's agent.
                             Required for --profile owner; unused for --profile client.

Optional:
  --profile <owner|client>   Whose desk this is (default: owner).
                             owner  — the operator's own desk: the Telegram channel, the named
                                      agents, their bindings and the Gmail hooks are configured
                                      at first boot.
                             client — a client's desk: only desk plumbing is configured, so the
                                      client gets the same onboarding as a fresh install — Model
                                      Setup, naming the assistant in the first conversation, and
                                      adding Telegram from Settings. --tg-token-file and
                                      --owner-target are not needed (and are ignored if passed).
  --size <slug>              doctl Droplet size slug (default: s-2vcpu-4gb).
  --git-ref <ref>            Fork ref to check out on first boot (default: main).
  --image <slug-or-id>       Base image, or THIS SAME desk's snapshot id (default:
                             ubuntu-24-04-x64). A snapshot carries the source desk's live
                             secrets - never seed one client's desk from another's; see
                             deploy/desk/README.md (Snapshot / restore).
  --gateway-token-file <f>   Pre-chosen Gateway auth token; a random one is generated if omitted.

Waits in two phases before printing anything: up to DESK_POLL_SECONDS for the desk to join
the tailnet (cloud-init runs `tailscale up` early), then up to DESK_READY_POLL_SECONDS for
its Gateway to answer over the tailnet (the fork checkout, install, build, managed-Chromium
install, and reboot all happen after the tailnet join, so this second phase is normally the
longer one — typically 15-25 minutes).

Environment overrides:
  DESK_SSH_KEY_NAME          doctl SSH key name to embed. Default: auto-detect — the first
                             doctl key whose fingerprint matches a public key in ~/.ssh, so
                             the printed sign-in command works from this machine.
  DESK_SSH_USER              account the printed sign-in command connects as (default: root —
                             DigitalOcean embeds the chosen SSH key into root's authorized_keys)
  DESK_REGION                DigitalOcean region (default: blr1)
  DESK_TAG                   droplet tag (default: desk)
  DESK_FIREWALL_NAME         cloud firewall name, created if missing (default: desk-no-inbound)
  DESK_POLL_SECONDS          seconds to wait for the tailnet hostname (default: 900)
  DESK_READY_POLL_SECONDS    seconds to wait for the Gateway to answer /healthz (default: 1800)
  DESK_FORK_REPO_URL         fork to clone on first boot (default: this checkout's own `origin`
                             remote, resolved by render-cloud-init.mjs — set this instead of
                             relying on the default if this checkout is not the fork itself)
EOF
}

for cmd in doctl jq tailscale curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "new-desk.sh: \"$cmd\" is required but not found on PATH — see deploy/desk/README.md (Prerequisites)" >&2
    exit 1
  fi
done

DESK_SSH_KEY_NAME="${DESK_SSH_KEY_NAME:-}"
DESK_SSH_USER="${DESK_SSH_USER:-root}"
DESK_REGION="${DESK_REGION:-blr1}"
DESK_TAG="${DESK_TAG:-desk}"
DESK_FIREWALL_NAME="${DESK_FIREWALL_NAME:-desk-no-inbound}"
DESK_POLL_SECONDS="${DESK_POLL_SECONDS:-900}"
DESK_READY_POLL_SECONDS="${DESK_READY_POLL_SECONDS:-1800}"
# Test-only knob: the real interval is a sensible fixed value; tests shrink it so a "succeeds
# after N attempts" or "never succeeds" case does not take N*10 (or 1800) real seconds.
DESK_READY_POLL_INTERVAL_SECONDS="${DESK_READY_POLL_INTERVAL_SECONDS:-10}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

desk_name=""
size="s-2vcpu-4gb"
git_ref="main"
image="ubuntu-24-04-x64"
ts_authkey_file=""
tg_token_file=""
owner_target=""
gateway_token_file=""
profile="owner"

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
    --profile)
      profile="$2"
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

case "$profile" in
  owner | client) ;;
  *)
    echo "new-desk.sh: --profile must be \"owner\" or \"client\", not \"$profile\"" >&2
    exit 2
    ;;
esac

# Fall back to the operator's gitignored .env so the tailnet key does not have to be re-supplied
# on every desk. The key is still only ever read from a file, never taken as an argument and never
# printed: this materializes it into a 0600 mktemp file that is removed on exit. `.env.example`
# documents the variable but must never hold the value — it is committed.
if [[ -z "$ts_authkey_file" ]]; then
  repo_env="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env"
  if [[ -f "$repo_env" ]]; then
    env_authkey="$(sed -n 's/^[[:space:]]*TAILSCALE_AUTHKEY[[:space:]]*=[[:space:]]*//p' "$repo_env" | tr -d '"'\''[:space:]' | head -n1)"
    if [[ -n "$env_authkey" ]]; then
      ts_authkey_file="$(mktemp -t desk-tsauthkey)"
      chmod 600 "$ts_authkey_file"
      printf '%s\n' "$env_authkey" >"$ts_authkey_file"
      # shellcheck disable=SC2064
      trap "rm -f '$ts_authkey_file'" EXIT
      unset env_authkey
      echo "new-desk.sh: using TAILSCALE_AUTHKEY from .env" >&2
    fi
  fi
fi

# A client desk renders no Telegram channel at all (see render-cloud-init.mjs --profile), so the
# bot token and owner target it would configure are required only for the owner's own desk.
if [[ -z "$desk_name" || -z "$ts_authkey_file" ]]; then
  usage >&2
  exit 2
fi
if [[ "$profile" == "owner" && ( -z "$tg_token_file" || -z "$owner_target" ) ]]; then
  usage >&2
  exit 2
fi

# jq takes the first match itself (`.[0] // empty`) rather than piping through `head -n1` —
# under `set -o pipefail`, `head` closing its read end early can deliver jq a SIGPIPE if more
# than one key ever shares this name, aborting the script instead of just picking one.
doctl_keys_json="$(doctl compute ssh-key list -o json)"
if [[ -n "$DESK_SSH_KEY_NAME" ]]; then
  echo "==> Looking up doctl SSH key \"$DESK_SSH_KEY_NAME\"" >&2
  ssh_key_id="$(
    jq -r --arg name "$DESK_SSH_KEY_NAME" '[.[] | select(.name == $name)] | (.[0].id // empty)' <<<"$doctl_keys_json"
  )"
  if [[ -z "$ssh_key_id" ]]; then
    echo "new-desk.sh: no doctl SSH key named \"$DESK_SSH_KEY_NAME\" — fix DESK_SSH_KEY_NAME or add the key in the DigitalOcean control panel" >&2
    exit 1
  fi
else
  # Auto-detect: the droplet embeds one doctl key into root's authorized_keys, and the sign-in
  # command this script prints only works if the matching private key lives on this machine.
  # doctl reports MD5 fingerprints, so compare against `ssh-keygen -E md5` of every ~/.ssh/*.pub.
  echo "==> Matching doctl SSH keys against ~/.ssh/*.pub" >&2
  ssh_key_id=""
  ssh_key_match=""
  for pub in "$HOME"/.ssh/*.pub; do
    [[ -f "$pub" ]] || continue
    fp="$(ssh-keygen -E md5 -lf "$pub" 2>/dev/null | awk '{print $2}' | sed 's/^MD5://')"
    [[ -n "$fp" ]] || continue
    ssh_key_id="$(
      jq -r --arg fp "$fp" '[.[] | select(.fingerprint == $fp)] | (.[0].id // empty)' <<<"$doctl_keys_json"
    )"
    if [[ -n "$ssh_key_id" ]]; then
      ssh_key_match="$(jq -r --arg fp "$fp" '[.[] | select(.fingerprint == $fp)] | (.[0].name // "")' <<<"$doctl_keys_json")"
      echo "==> Using doctl SSH key \"$ssh_key_match\" (matches $(basename "$pub"))" >&2
      break
    fi
  done
  if [[ -z "$ssh_key_id" ]]; then
    echo "new-desk.sh: none of the doctl SSH keys match a public key in ~/.ssh — add this machine's key in the DigitalOcean control panel, or set DESK_SSH_KEY_NAME to a key whose private half you have. doctl keys: $(jq -r '[.[] | .name] | join(", ")' <<<"$doctl_keys_json")" >&2
    exit 1
  fi
fi

echo "==> Ensuring firewall \"$DESK_FIREWALL_NAME\" exists (no inbound, all outbound)" >&2
firewall_id="$(
  doctl compute firewall list -o json \
    | jq -r --arg name "$DESK_FIREWALL_NAME" '[.[] | select(.name == $name)] | (.[0].id // empty)'
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

echo "==> Rendering cloud-init for \"$desk_name\" ($profile profile, git-ref $git_ref)" >&2
render_args=(
  --name "$desk_name"
  --profile "$profile"
  --ts-authkey-file "$ts_authkey_file"
  --git-ref "$git_ref"
)
# Passed through even under the client profile when the operator supplied them, so the renderer
# — the one owner of what each profile configures — is what says they go unused, rather than this
# script dropping them silently.
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
  | [ (((.Peer // {}) | to_entries | map(.value)))[]
      | select((.HostName // "") | ascii_downcase == ($name | ascii_downcase))
      | select(.Online == true)
      | .HostName + "." + ($suffix // "" | rtrimstr("."))
    ]
  | (.[0] // empty)
'
while (( SECONDS < poll_deadline )); do
  status_json="$(tailscale status --json 2>/dev/null || true)"
  if [[ -n "$status_json" ]]; then
    # jq collects every match into an array and takes the first itself, rather than piping
    # through `head -n1` — see the SSH-key lookup above for why that pattern is unsafe under
    # `set -o pipefail`.
    tailnet_host="$(
      printf '%s' "$status_json" \
        | jq -r --arg name "$desk_name" "$tailnet_peer_filter" 2>/dev/null
    )"
  fi
  if [[ -n "$tailnet_host" ]]; then
    break
  fi
  sleep 10
done

if [[ -z "$tailnet_host" ]]; then
  echo "new-desk.sh: \"$desk_name\" did not appear on the tailnet within ${DESK_POLL_SECONDS}s — check \`tailscale status\` and the droplet's cloud-init log (\`ssh ${DESK_SSH_USER}@${desk_name} 'cloud-init status --long'\` once it is reachable)" >&2
  exit 1
fi

# The desk joining the tailnet only means `tailscale up` (an early cloud-init step) finished —
# the fork checkout, install, build, managed-Chromium install, and reboot all happen after that,
# so the Gateway (and the Control UI Tailscale Serve fronts) is not necessarily up yet. Poll it
# directly before printing anything, so a printed URL always actually works.
control_ui_url="https://${tailnet_host}"
echo "==> Waiting up to ${DESK_READY_POLL_SECONDS}s for the Gateway at ${control_ui_url} to answer (checkout, install, build, Chromium, reboot — typically 15-25 minutes)" >&2
gateway_ready=0
ready_deadline=$((SECONDS + DESK_READY_POLL_SECONDS))
next_progress_at=$((SECONDS + 60))
while (( SECONDS < ready_deadline )); do
  if curl -fsS --max-time 5 -o /dev/null "${control_ui_url}/healthz" 2>/dev/null; then
    gateway_ready=1
    break
  fi
  if (( SECONDS >= next_progress_at )); then
    echo "==> Still building \"$desk_name\" ($(( SECONDS / 60 ))m elapsed)..." >&2
    next_progress_at=$((SECONDS + 60))
  fi
  sleep "$DESK_READY_POLL_INTERVAL_SECONDS"
done

if [[ "$gateway_ready" -ne 1 ]]; then
  echo "new-desk.sh: \"$desk_name\" joined the tailnet but its Gateway never answered ${control_ui_url}/healthz within ${DESK_READY_POLL_SECONDS}s — check \`ssh ${DESK_SSH_USER}@${desk_name} journalctl -u openclaw-gateway -u cloud-init-output --no-pager\`" >&2
  exit 4
fi

# A desk whose Chromium install or fork checkout failed still answers /healthz, so "the Gateway
# is up" is not "provisioning succeeded" — cloud-init leaves /var/lib/openclaw/provision-failed
# behind in either case (see cloud-init.yaml.tmpl). Surface it here rather than letting it show up
# much later as a browser step dying mid-Duty; desk-health.sh reports the same marker as
# `provisioned: false` to the Duties page's Desk card.
if ssh -o BatchMode=yes "${DESK_SSH_USER}@${desk_name}" 'test -f /var/lib/openclaw/provision-failed' 2>/dev/null; then
  echo >&2
  echo "WARNING: \"$desk_name\" left /var/lib/openclaw/provision-failed behind — part of first boot failed (managed Chromium, or the fork checkout). The Gateway is up, but browser Duties will fail until it is fixed. Check: ssh ${DESK_SSH_USER}@${desk_name} journalctl -u cloud-init-output --no-pager" >&2
fi

echo
echo "Desk \"$desk_name\" is up."
echo "Control UI: ${control_ui_url}"
# `ssh -t` (the Gateway refuses to print its token without a TTY on both ends) and `sudo -H` (so
# the CLI reads the service user's own ~/.openclaw, not root's) are both required — without
# either, this very first operator step fails.
echo "Sign in:    ssh -t ${DESK_SSH_USER}@${desk_name} 'sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'"
if [[ "$profile" == "client" ]]; then
  # Nothing is configured beyond desk plumbing on a client desk, so say where the client picks up
  # rather than leaving a Control UI that looks half-finished.
  echo
  echo "Client desk: the Control UI opens on the same onboarding a fresh install shows."
  echo "  1. Model Setup - connect Claude by signing in."
  echo "  2. First conversation - name the assistant when it asks."
  echo "  3. Settings > Telegram - paste a BotFather token to add Telegram."
  echo "See deploy/desk/README.md (\"Client desk\") for what to hand over."
fi
