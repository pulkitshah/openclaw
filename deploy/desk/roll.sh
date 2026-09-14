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
  DESK_SSH_USER       account to SSH into the desk as (default: root — DigitalOcean embeds
                       the chosen SSH key into root's authorized_keys on a fresh droplet)
  DESK_GATEWAY_PORT   Gateway HTTP port to health-check (default: 18789)
EOF
}

for cmd in ssh jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "roll.sh: \"$cmd\" is required but not found on PATH — see deploy/desk/README.md (Prerequisites)" >&2
    exit 1
  fi
done

DESK_SSH_USER="${DESK_SSH_USER:-root}"
GATEWAY_PORT="${DESK_GATEWAY_PORT:-18789}"
# Same pattern render-cloud-init.mjs enforces on --git-ref before it reaches a shell string
# (deploy/desk/render-cloud-init.mjs: GIT_REF_RE) — roll.sh has no renderer in its path, so it
# validates independently before <git-ref> ever reaches the remote shell.
GIT_REF_RE='^[A-Za-z0-9._/-]{1,128}$'

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

if [[ "$git_ref" == -* ]]; then
  echo "roll.sh: <git-ref> \"$git_ref\" is invalid: must not start with '-'" >&2
  exit 2
fi
if ! [[ "$git_ref" =~ $GIT_REF_RE ]]; then
  echo "roll.sh: <git-ref> \"$git_ref\" is invalid: must match $GIT_REF_RE (letters, digits, '.', '_', '/', '-'; max 128 chars)" >&2
  exit 2
fi

ssh_target="${DESK_SSH_USER}@${desk_name}"

if [[ "$force" -eq 0 ]]; then
  echo "==> Checking whether \"$desk_name\" is busy" >&2
  remote_busy_check='sudo -u openclaw node /opt/openclaw/openclaw.mjs gateway call duties.runs.recent --params "{\"limit\":10}" --json'
  runs_json="$(ssh "$ssh_target" "$remote_busy_check")"
  # The jq filter itself takes the first match (`.[0] // empty`) instead of piping through
  # `head -n1` — under `set -o pipefail`, `head -n1` closing its read end after one line can
  # deliver jq a SIGPIPE when more than one run is busy (the exact condition this check exists
  # to catch), which would abort this script before it ever reaches the exit-3 message below.
  busy_line="$(
    printf '%s' "$runs_json" \
      | jq -r '
          [ .runs[]?
            | select(.status == "running" or .status == "needs_input" or .status == "queued")
            | "\(.id)\t\(.status)"
          ] | (.[0] // empty)
        '
  )"
  if [[ -n "$busy_line" ]]; then
    busy_id="${busy_line%%$'\t'*}"
    busy_status="${busy_line##*$'\t'}"
    echo "desk is busy: run ${busy_id} is ${busy_status}; retry later or --force" >&2
    exit 3
  fi
fi

mode="restart"
if [[ "$reboot" -eq 1 ]]; then
  mode="reboot"
fi

echo "==> Rolling \"$desk_name\" to ${git_ref}" >&2
# <git-ref> is already validated above (no shell metacharacters possible), but it is still
# passed as its own argument to a `bash -s --` positional parameter rather than interpolated
# into the remote script text, so a validation gap here could never reopen the injection this
# guards against. The heredoc delimiter is quoted ('REMOTE') so nothing in it is locally
# expanded — every value it needs ($1/$2/$3) is resolved on the remote side instead.
ssh "$ssh_target" bash -s -- "$git_ref" "$GATEWAY_PORT" "$mode" <<'REMOTE'
set -euo pipefail
git_ref="$1"
gateway_port="$2"
mode="$3"
cd /opt/openclaw
git fetch origin "$git_ref"
git checkout --detach FETCH_HEAD
npm_config_minimum_release_age=0 npm_config_minimum_release_age_strict=false pnpm install --frozen-lockfile --ignore-scripts
pnpm build
chown -R root:openclaw /opt/openclaw
chmod -R g+rX,o-rwx /opt/openclaw
if [ "$mode" = "reboot" ]; then
  systemctl reboot
  exit 0
fi
systemctl restart openclaw-gateway
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${gateway_port}/healthz"; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" -ne 1 ]; then
  echo "openclaw-gateway did not answer /healthz on port ${gateway_port} within 120s" >&2
  exit 1
fi
sudo -u openclaw node /opt/openclaw/openclaw.mjs --version
REMOTE

if [[ "$reboot" -eq 1 ]]; then
  echo "Desk \"$desk_name\" is rebooting — services restart automatically; check with the health probe once it is back on the tailnet."
else
  echo "Desk \"$desk_name\" rolled to ${git_ref} and is healthy."
fi
