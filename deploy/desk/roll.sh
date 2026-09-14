#!/usr/bin/env bash
# Rolls a hosted desk to a new ref in place, over tailnet SSH. See docs/superpowers/specs/
# 2026-09-14-hosted-desk-design.md §3 (provisioning) and §9 (ops: restart recipe).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: roll.sh <desk-name> [<git-ref>] [--force] [--reboot]

Rolls a hosted desk to <git-ref> (default: main) over tailnet SSH:
  1. Unless --force, checks the desk is idle (no running/needs_input/queued Duty run) and
     exits 3 if it is busy.
  2. Fetches and checks out <git-ref>, reinstalls (frozen lockfile, ignore-scripts) and
     rebuilds, restores root:openclaw ownership.
  3. Restarts the Gateway and waits for /healthz to answer 200, then prints its reported
     version — or, with --reboot, reboots the whole box instead (for kernel/package updates
     that need a window the owner picks; the Gateway's 45s-drain-then-SIGKILL unit handles the
     stop cleanly either way).

Exit code 3 means the desk is busy — retry later, or pass --force to roll anyway.

Environment overrides:
  DESK_GATEWAY_PORT   Gateway HTTP port to health-check (default: 18789)
EOF
}

GATEWAY_PORT="${DESK_GATEWAY_PORT:-18789}"

desk_name=""
git_ref="main"
have_git_ref=0
force=0
reboot=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)
      force=1
      shift
      ;;
    --reboot)
      reboot=1
      shift
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
      echo "roll.sh: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$desk_name" ]]; then
        desk_name="$1"
      elif [[ "$have_git_ref" -eq 0 ]]; then
        git_ref="$1"
        have_git_ref=1
      else
        echo "roll.sh: unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "$desk_name" ]]; then
  usage >&2
  exit 2
fi

if [[ "$force" -eq 0 ]]; then
  echo "==> Checking whether \"$desk_name\" is busy" >&2
  remote_busy_check='sudo -u openclaw node /opt/openclaw/openclaw.mjs gateway call duties.runs.recent --params "{\"limit\":10}" --json'
  runs_json="$(ssh "$desk_name" "$remote_busy_check")"
  busy_line="$(
    printf '%s' "$runs_json" \
      | jq -r '
          .runs[]?
          | select(.status == "running" or .status == "needs_input" or .status == "queued")
          | "\(.id)\t\(.status)"
        ' \
      | head -n1
  )"
  if [[ -n "$busy_line" ]]; then
    busy_id="${busy_line%%$'\t'*}"
    busy_status="${busy_line##*$'\t'}"
    echo "desk is busy: run ${busy_id} is ${busy_status}; retry later or --force" >&2
    exit 3
  fi
fi

echo "==> Rolling \"$desk_name\" to ${git_ref}" >&2
remote_script=$(
  cat <<REMOTE
set -euo pipefail
cd /opt/openclaw
git fetch origin '${git_ref}'
git checkout --detach FETCH_HEAD
npm_config_minimum_release_age=0 npm_config_minimum_release_age_strict=false pnpm install --frozen-lockfile --ignore-scripts
pnpm build
chown -R root:openclaw /opt/openclaw
chmod -R g+rX,o-rwx /opt/openclaw
REMOTE
)

if [[ "$reboot" -eq 1 ]]; then
  remote_script="${remote_script}
systemctl reboot"
else
  remote_script="${remote_script}
systemctl restart openclaw-gateway
healthy=0
for _ in \$(seq 1 60); do
  if curl -fsS -o /dev/null \"http://127.0.0.1:${GATEWAY_PORT}/healthz\"; then
    healthy=1
    break
  fi
  sleep 2
done
if [ \"\$healthy\" -ne 1 ]; then
  echo \"openclaw-gateway did not answer /healthz on port ${GATEWAY_PORT} within 120s\" >&2
  exit 1
fi
sudo -u openclaw node /opt/openclaw/openclaw.mjs --version"
fi

ssh "$desk_name" "$remote_script"

if [[ "$reboot" -eq 1 ]]; then
  echo "Desk \"$desk_name\" is rebooting — services restart automatically; check with the health probe once it is back on the tailnet."
else
  echo "Desk \"$desk_name\" rolled to ${git_ref} and is healthy."
fi
