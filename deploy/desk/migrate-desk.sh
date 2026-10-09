#!/usr/bin/env bash
# Moves a hosted desk's state from one box to another over tailnet SSH: the Gateway's whole
# ~openclaw/.openclaw (config, sessions, workspaces, plugin state, media), the Claude CLI and gog
# logins, the credential keyfile and the secrets, and the desk's own Caddy front (if it has one).
# Used to move a desk between hosts — a DigitalOcean droplet to an Oracle Cloud instance, a bigger
# to a smaller box — without re-onboarding the client. See deploy/desk/README.md ("Migrate").
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: migrate-desk.sh <source-desk> <target-desk> [--public-host <host>] [--force]

Copies one desk's state onto another, already-provisioned desk and brings the Gateway up there:
  1. Both desks must answer over the tailnet as root and run the same fork ref (/opt/openclaw);
     roll the target first if they differ.
  2. Unless --force, checks the source is idle (no running/needs_input/queued Duty run) and
     exits 3 if it is busy.
  3. Stops AND disables the source Gateway (two Gateways on one Telegram bot or mailbox would
     fight over it; the source stays down from here, and a reboot must not bring it back), stops
     the target Gateway, and streams the state over (tar through this machine, since the desks
     hold no key for each other). The target's own fresh ~openclaw/.openclaw is replaced.
  4. If the source has /etc/caddy/Caddyfile (a desk reached through the front door on its own
     public host), installs Caddy on the target and writes the same Caddyfile for the target's
     public host (--public-host, default <target-public-ip-with-dashes>.sslip.io) and IP, and
     swaps the old public host and tailnet name in the Gateway's controlUi.allowedOrigins.
  5. Starts the target Gateway, waits for /healthz, and prints what is left to do by hand: the
     front door's route, the tailnet node, the verification, and tearing the source down.

Any failure after the source is stopped puts the source back (enabled and started) and leaves
the target stopped and disabled for inspection: exit 5 for the copy and the target-side fix-ups,
6 when the target Gateway would not start or answer /healthz. Nothing on the source is deleted.

Environment overrides:
  DESK_SSH_USER        account to SSH into both desks as (default: root)
  DESK_GATEWAY_PORT    Gateway HTTP port to health-check on the target (default: 18789)
EOF
}

for cmd in ssh jq curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "migrate-desk.sh: \"$cmd\" is required but not found on PATH — see deploy/desk/README.md (Prerequisites)" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/desk-ops.sh
source "$SCRIPT_DIR/lib/desk-ops.sh"

DESK_SSH_USER="${DESK_SSH_USER:-root}"
GATEWAY_PORT="${DESK_GATEWAY_PORT:-18789}"
DESK_NAME_RE='^[a-z0-9][a-z0-9-]{0,62}$'

source_desk=""
target_desk=""
public_host=""
force=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-host) public_host="$2"; shift 2 ;;
    --force) force=1; shift ;;
    -h | --help) usage; exit 0 ;;
    --) shift; break ;;
    -*)
      echo "migrate-desk.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$source_desk" ]]; then
        source_desk="$1"
      elif [[ -z "$target_desk" ]]; then
        target_desk="$1"
      else
        echo "migrate-desk.sh: unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$source_desk" || -z "$target_desk" ]]; then
  usage >&2
  exit 2
fi
for name in "$source_desk" "$target_desk"; do
  if ! [[ "$name" =~ $DESK_NAME_RE ]]; then
    echo "migrate-desk.sh: desk name \"$name\" is invalid: must be a plain hostname (lowercase letters, digits and hyphens)" >&2
    exit 2
  fi
done
if [[ "$source_desk" == "$target_desk" ]]; then
  echo "migrate-desk.sh: source and target are the same desk" >&2
  exit 2
fi
if [[ -n "$public_host" ]] && ! [[ "$public_host" =~ ^[a-z0-9][a-z0-9.-]{0,252}$ ]]; then
  echo "migrate-desk.sh: --public-host \"$public_host\" is invalid: must be a plain DNS name" >&2
  exit 2
fi

src="${DESK_SSH_USER}@${source_desk}"
dst="${DESK_SSH_USER}@${target_desk}"

# What moves. Everything under the service user's home that holds state or a login, plus the
# keyfile and secrets. Missing optional entries (gog's two layouts, the Claude CLI login) are
# fine. NOT /opt/openclaw (built from git on the target) and NOT ~openclaw/.cache (the managed
# Chromium for the source's CPU architecture; the target installed its own).
STATE_PATHS=(
  home/openclaw/.openclaw
  home/openclaw/.claude
  home/openclaw/.claude.json
  home/openclaw/.config
  home/openclaw/.local
  home/openclaw/.gogcli
  etc/openclaw/keyfile
  etc/openclaw/secrets
)

echo "==> Checking both desks" >&2
src_ref="$(ssh -o BatchMode=yes "$src" 'git -C /opt/openclaw rev-parse HEAD')"
dst_ref="$(ssh -o BatchMode=yes "$dst" 'git -C /opt/openclaw rev-parse HEAD')"
if [[ "$src_ref" != "$dst_ref" ]]; then
  echo "migrate-desk.sh: \"$source_desk\" runs ${src_ref:0:10} but \"$target_desk\" runs ${dst_ref:0:10} — roll the target to the same ref first (deploy/desk/roll.sh $target_desk ${src_ref})" >&2
  exit 1
fi
if ! ssh -o BatchMode=yes "$dst" 'test -f /etc/systemd/system/openclaw-gateway.service && id openclaw >/dev/null'; then
  echo "migrate-desk.sh: \"$target_desk\" is not a provisioned desk (no openclaw-gateway unit or openclaw user)" >&2
  exit 1
fi

if [[ "$force" -eq 0 ]]; then
  echo "==> Checking whether \"$source_desk\" is busy" >&2
  busy_line="$(desk_busy_run "$src")"
  if [[ -n "$busy_line" ]]; then
    busy_id="${busy_line%%$'\t'*}"
    busy_status="${busy_line##*$'\t'}"
    echo "desk is busy: run ${busy_id} is ${busy_status}; retry later or --force" >&2
    exit 3
  fi
fi

# Everything that can be learned or computed is done BEFORE anything stops, so a lookup failure
# costs nothing: the source's own Caddy front (if any), and the target's addresses.
source_caddyfile=""
if ssh -o BatchMode=yes "$src" 'test -f /etc/caddy/Caddyfile'; then
  source_caddyfile="$(ssh -o BatchMode=yes "$src" 'cat /etc/caddy/Caddyfile')"
fi
# Two addresses: the public one (for the sslip.io host the front door reaches) and the one the
# interface actually holds, which Caddy must `bind` to. They are the same on a droplet; on Oracle
# Cloud the public IP is NATed and binding to it fails with "cannot assign requested address".
target_public_ip="$(ssh -o BatchMode=yes "$dst" 'curl -fsS --max-time 5 -4 https://api.ipify.org 2>/dev/null || true')"
target_bind_ip="$(ssh -o BatchMode=yes "$dst" "ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n1" || true)"
target_ts_name="$(ssh -o BatchMode=yes "$dst" 'tailscale status --json 2>/dev/null' | jq -r '.Self.DNSName // "" | rtrimstr(".")' 2>/dev/null || true)"

target_caddyfile=""
old_public_host=""
if [[ -n "$source_caddyfile" ]]; then
  if [[ -z "$public_host" ]]; then
    if [[ -z "$target_public_ip" ]]; then
      echo "migrate-desk.sh: could not learn \"$target_desk\"'s public IP to derive its sslip.io host — pass --public-host" >&2
      exit 1
    fi
    public_host="${target_public_ip//./-}.sslip.io"
  fi
  if [[ -z "$target_bind_ip" ]]; then
    echo "migrate-desk.sh: could not learn the address \"$target_desk\"'s interface holds (ip route) for Caddy to bind to" >&2
    exit 1
  fi
  # The source's host block is `<old-public-host> {` with `bind <old-ip>`; everything else (the
  # basicauth hash, the X-Forwarded-User header, the loopback upstream) carries over unchanged.
  old_public_host="$(printf '%s\n' "$source_caddyfile" | sed -n -E 's/^([a-z0-9.-]+)[[:space:]]*\{[[:space:]]*$/\1/p' | head -n1)"
  if [[ -z "$old_public_host" ]]; then
    echo "migrate-desk.sh: could not find the site block in \"$source_desk\"'s Caddyfile — copy it to \"$target_desk\" by hand after this move" >&2
  else
    target_caddyfile="$(
      printf '%s\n' "$source_caddyfile" \
        | sed -E "s/^${old_public_host//./\\.}([[:space:]]*\\{)/${public_host}\\1/; s/^([[:space:]]*bind[[:space:]]+)[0-9.]+/\\1${target_bind_ip}/"
    )"
  fi
fi

# From here the desks change. The target stops first (it holds nothing yet, so a failure here
# leaves the client's desk untouched); then the source is disabled. After that point every
# failure puts the source back and leaves the target stopped AND disabled, so neither a retry
# nor a reboot of the target can start a second Gateway on the client's bot and mailboxes.
echo "==> Stopping the Gateway on \"$target_desk\"" >&2
ssh -o BatchMode=yes "$dst" 'systemctl disable --now openclaw-gateway'

restore_source() {
  echo "==> Putting \"$source_desk\" back: Gateway enabled and started again" >&2
  ssh -o BatchMode=yes "$dst" 'systemctl disable --now openclaw-gateway' || true
  ssh -o BatchMode=yes "$src" 'systemctl enable --now openclaw-gateway' || true
}
fail_and_restore() {
  local code="$1" message="$2"
  echo "migrate-desk.sh: ${message}; \"$target_desk\" is left stopped and disabled for inspection" >&2
  restore_source
  exit "$code"
}

echo "==> Stopping and disabling the Gateway on \"$source_desk\" (the desk is down from here)" >&2
ssh -o BatchMode=yes "$src" 'systemctl disable --now openclaw-gateway' \
  || fail_and_restore 1 "could not stop the source Gateway cleanly"

echo "==> Copying state ${source_desk} -> ${target_desk} (through this machine; a few GB takes some minutes)" >&2
# `--ignore-failed-read` so an absent optional path is not an error; `-p`/same-owner as root
# restores ownership by NAME (openclaw exists on both boxes, whatever its uid). The target's fresh
# ~openclaw/.openclaw goes first so nothing from the client-profile first boot lingers under the
# moved state.
if ! ssh -o BatchMode=yes "$src" "tar -C / -czf - --ignore-failed-read ${STATE_PATHS[*]}" \
  | ssh -o BatchMode=yes "$dst" 'rm -rf /home/openclaw/.openclaw && tar -C / -xzpf - --same-owner'; then
  fail_and_restore 5 "copying the state failed"
fi

echo "==> Fixing ownership and modes on \"$target_desk\"" >&2
ssh -o BatchMode=yes "$dst" '
  chown -R openclaw:openclaw /home/openclaw/.openclaw /home/openclaw/.claude /home/openclaw/.claude.json /home/openclaw/.config /home/openclaw/.local /home/openclaw/.gogcli 2>/dev/null || true
  chown root:openclaw /etc/openclaw/keyfile && chmod 640 /etc/openclaw/keyfile
' || fail_and_restore 5 "fixing ownership on the target failed"

if [[ -n "$target_caddyfile" ]]; then
  echo "==> Installing Caddy on \"$target_desk\" for ${public_host} (bind ${target_bind_ip})" >&2
  # apt-get gets /dev/null for stdin so it cannot swallow the Caddyfile that follows on the
  # session's stdin.
  ssh -o BatchMode=yes "$dst" 'command -v caddy >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y caddy </dev/null >/dev/null; cat > /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile >/dev/null && systemctl enable --now caddy && systemctl reload caddy' <<<"$target_caddyfile" \
    || fail_and_restore 5 "installing Caddy on the target failed"
  echo "==> Rewriting controlUi.allowedOrigins on \"$target_desk\" (${old_public_host} -> ${public_host}; tailnet name -> ${target_ts_name:-unchanged})" >&2
  ssh -o BatchMode=yes "$dst" "sudo -H -u openclaw node -e '
    const fs = require(\"node:fs\");
    const file = \"/home/openclaw/.openclaw/openclaw.json\";
    const cfg = JSON.parse(fs.readFileSync(file, \"utf8\"));
    const origins = cfg.gateway?.controlUi?.allowedOrigins;
    if (Array.isArray(origins)) {
      cfg.gateway.controlUi.allowedOrigins = [...new Set(origins.map((o) =>
        o === \"https://${old_public_host}\" ? \"https://${public_host}\" :
        (/\\.ts\\.net\$/.test(o) && \"${target_ts_name}\") ? \"https://${target_ts_name}\" : o))];
      fs.writeFileSync(file + \".tmp\", JSON.stringify(cfg, null, 2) + \"\\n\");
      fs.renameSync(file + \".tmp\", file);
    }
  '" || fail_and_restore 5 "rewriting the Gateway's allowed origins on the target failed"
fi

echo "==> Starting the Gateway on \"$target_desk\"" >&2
ssh -o BatchMode=yes "$dst" 'systemctl enable --now openclaw-gateway' \
  || fail_and_restore 6 "the target Gateway would not start"
if ! ssh -o BatchMode=yes "$dst" "for _ in \$(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:${GATEWAY_PORT}/healthz && exit 0; sleep 2; done; exit 1"; then
  fail_and_restore 6 "the Gateway on \"$target_desk\" did not answer /healthz within 120s (check: ssh ${dst} journalctl -u openclaw-gateway --no-pager)"
fi

echo
echo "Desk state moved: ${source_desk} -> ${target_desk}."
echo "Source Gateway: stopped and disabled on ${source_desk} (not destroyed)."
if [[ -n "$public_host" ]]; then
  echo "Public host:    https://${public_host} (Caddy on ${target_desk}, same sign-in as before)"
fi
echo "Tailnet:        https://${target_ts_name:-<target>.<tailnet>.ts.net}"
echo
echo "Left to do by hand:"
if [[ -n "$public_host" ]]; then
  echo "  1. Front door: point this client's route at https://${public_host} (host header too), then caddy validate + systemctl reload caddy."
fi
echo "  2. Verify a real sign-in through the front door reaches ${target_desk} (watch its journal for served [ws] RPC)."
echo "  3. Remove ${source_desk} from the tailnet admin console and destroy its box once the client has used the new desk."
