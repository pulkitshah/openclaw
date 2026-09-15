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
  2. Snapshots the current build (dist + its git ref) and stops the Gateway (the desk is
     briefly down and Duties are refused for the rest of this step), then fetches and checks
     out <git-ref>, reinstalls (frozen lockfile, ignore-scripts) and rebuilds against the
     now-idle checkout — runtime-only, the same mode and heap ceiling cloud-init's own first
     boot uses, so a default-size (4 GB) desk can actually complete the build.
  3. On success: restores root:openclaw ownership, discards the snapshot, starts the Gateway
     and waits for /healthz to answer 200, then prints its reported version — or, with
     --reboot, reboots the whole box instead (for kernel/package updates that need a window
     the owner picks; the enabled unit starts back up on its own after the reboot).
     On failure (fetch/install/build): restores the snapshot (dist, the git checkout and that
     ref's own node_modules all revert to what was serving before this roll), restarts the
     Gateway on it, and exits 5 — or 6 if the Gateway does not come back up even on the
     restored build (see the printed journalctl command). The Gateway's 45s-drain-then-SIGKILL
     unit handles every stop above cleanly regardless of which path is taken.

The body that runs on the desk is deploy/desk/remote/roll-remote.sh, sent over stdin — this
script must be run from a complete checkout of the repo so that file is on hand.

Exit code 3 means the desk is busy — retry later, or pass --force to roll anyway. Exit code 5
means the roll failed but the previous build is back up; exit code 6 means it failed and the
Gateway would not even restart on the restored build — SSH in and investigate.

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The body that runs ON the desk. Shipped as its own file in the tree (not a heredoc here) so it
# can be executed for real by deploy/desk/scripts.test.ts — the recovery branch is the one piece
# of this that runs on a live client desk after a failed roll, and string-matching a heredoc was
# not proof it works. The operator's own checkout carries it next to this script.
REMOTE_SCRIPT="$SCRIPT_DIR/remote/roll-remote.sh"

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

if [[ ! -f "$REMOTE_SCRIPT" ]]; then
  echo "roll.sh: the remote roll script is missing at $REMOTE_SCRIPT — run roll.sh from a complete checkout of this repo" >&2
  exit 1
fi

ssh_target="${DESK_SSH_USER}@${desk_name}"

if [[ "$force" -eq 0 ]]; then
  echo "==> Checking whether \"$desk_name\" is busy" >&2
  # `sudo -H`: stock Ubuntu sudoers is `env_reset` without `always_set_home`, so plain
  # `sudo -u openclaw` leaves $HOME=/root and the CLI reads /root/.openclaw instead of the
  # service user's own config (one `sudo -H` convention across this repo's desk commands).
  # Trusted-proxy desks (a desk sitting behind the front door) have no token this local CLI
  # call can present; per docs/gateway/trusted-proxy-auth.md, an internal same-host caller falls
  # back to `gateway.auth.password` instead. When that secret file exists on the desk, read it
  # and pass it through; a desk still on token auth has no such file and this stays a no-op.
  remote_busy_check='PW_FILE=/etc/openclaw/secrets/gateway-admin-password; if [ -f "$PW_FILE" ]; then sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway call duties.runs.recent --params "{\"limit\":10}" --json --password "$(cat "$PW_FILE")"; else sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway call duties.runs.recent --params "{\"limit\":10}" --json; fi'
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
# guards against. The script itself arrives on stdin from the tree (remote/roll-remote.sh), so
# nothing in it is expanded locally either - every value it needs ($1/$2/$3/$4) resolves on the
# remote side.
ssh "$ssh_target" bash -s -- "$desk_name" "$git_ref" "$GATEWAY_PORT" "$mode" < "$REMOTE_SCRIPT"

if [[ "$reboot" -eq 1 ]]; then
  echo "Desk \"$desk_name\" is rebooting — services restart automatically; check with the health probe once it is back on the tailnet."
else
  echo "Desk \"$desk_name\" rolled to ${git_ref} and is healthy."
fi
