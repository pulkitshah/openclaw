# Shared by the operator scripts (new-desk.sh, new-desk-oci.sh, roll.sh, migrate-desk.sh): the
# one copy of "is this desk busy?", the two readiness waits every create script runs (first for
# the desk to join the tailnet — cloud-init runs `tailscale up` early — then for its Gateway to
# answer over the tailnet, the long phase since checkout, install, build, Chromium and reboot all
# happen after the join), and the ready banner. Sourced, not executed; the callers own their own
# `set -euo pipefail` and the `tailscale`/`curl`/`ssh`/`jq` prerequisite checks.

# Prints "<run-id>\t<status>" for the first running/needs_input/queued Duty run on the desk at
# <ssh-target>, or nothing when it is idle. `sudo -H`: stock Ubuntu sudoers is `env_reset`
# without `always_set_home`, so plain `sudo -u openclaw` leaves $HOME=/root and the CLI reads
# /root/.openclaw instead of the service user's own config (one `sudo -H` convention across this
# repo's desk commands). Trusted-proxy desks (a desk sitting behind the front door) have no token
# this local CLI call can present; per docs/gateway/trusted-proxy-auth.md, an internal same-host
# caller falls back to `gateway.auth.password` instead. When that secret file exists on the desk,
# read it and pass it through; a desk still on token auth has no such file and this stays a no-op.
desk_busy_run() {
  local ssh_target="$1"
  local remote_busy_check='PW_FILE=/etc/openclaw/secrets/gateway-admin-password; if [ -f "$PW_FILE" ]; then sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway call duties.runs.recent --params "{\"limit\":10}" --json --password "$(cat "$PW_FILE")"; else sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway call duties.runs.recent --params "{\"limit\":10}" --json; fi'
  local runs_json
  # A failed call (ssh down, Gateway down, call rejected) must read as "unknown", never as "idle":
  # the caller's assignment then fails and its `set -e` stops it before it stops anything.
  runs_json="$(ssh "$ssh_target" "$remote_busy_check")" || return 1
  # The jq filter itself takes the first match (`.[0] // empty`) instead of piping through
  # `head -n1` — under `set -o pipefail`, `head -n1` closing its read end after one line can
  # deliver jq a SIGPIPE when more than one run is busy (the exact condition this check exists
  # to catch), which would abort the caller before it ever reports the busy run.
  printf '%s' "$runs_json" \
    | jq -r '
        [ .runs[]?
          | select(.status == "running" or .status == "needs_input" or .status == "queued")
          | "\(.id)\t\(.status)"
        ] | (.[0] // empty)
      '
}

# Polls `tailscale status` until a peer with HostName <desk-name> is online, for up to <seconds>.
# Prints the desk's MagicDNS name (e.g. desk-acme.tailnet.ts.net) and returns 0; returns 1 with
# nothing printed on timeout.
desk_wait_for_tailnet_host() {
  local desk_name="$1" seconds="$2"
  local deadline=$((SECONDS + seconds))
  local status_json tailnet_host=""
  # jq collects every match into an array and takes the first itself, rather than piping through
  # `head -n1` — under `set -o pipefail`, `head` closing its read end early can deliver jq a
  # SIGPIPE if more than one peer ever shares this name, aborting the caller instead of just
  # picking one.
  local peer_filter='
    .MagicDNSSuffix as $suffix
    | [ (((.Peer // {}) | to_entries | map(.value)))[]
        | select((.HostName // "") | ascii_downcase == ($name | ascii_downcase))
        | select(.Online == true)
        | .HostName + "." + ($suffix // "" | rtrimstr("."))
      ]
    | (.[0] // empty)
  '
  while (( SECONDS < deadline )); do
    status_json="$(tailscale status --json 2>/dev/null || true)"
    if [[ -n "$status_json" ]]; then
      tailnet_host="$(printf '%s' "$status_json" | jq -r --arg name "$desk_name" "$peer_filter" 2>/dev/null)"
    fi
    if [[ -n "$tailnet_host" ]]; then
      printf '%s\n' "$tailnet_host"
      return 0
    fi
    sleep 10
  done
  return 1
}

# Polls <control-ui-url>/healthz every <interval> seconds for up to <seconds>, printing a progress
# line to stderr once a minute. Returns 0 once it answers, 1 on timeout.
desk_wait_for_gateway() {
  local desk_name="$1" control_ui_url="$2" seconds="$3" interval="$4"
  local deadline=$((SECONDS + seconds))
  local next_progress_at=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 -o /dev/null "${control_ui_url}/healthz" 2>/dev/null; then
      return 0
    fi
    if (( SECONDS >= next_progress_at )); then
      echo "==> Still building \"$desk_name\" ($(( SECONDS / 60 ))m elapsed)..." >&2
      next_progress_at=$((SECONDS + 60))
    fi
    sleep "$interval"
  done
  return 1
}

# A desk whose Chromium install or fork checkout failed still answers /healthz, so "the Gateway is
# up" is not "provisioning succeeded" — cloud-init leaves /var/lib/openclaw/provision-failed behind
# in either case (see cloud-init.yaml.tmpl). Surface it here rather than letting it show up much
# later as a browser step dying mid-Duty; desk-health.sh reports the same marker as
# `provisioned: false` to the Duties page's Desk card.
desk_warn_if_provision_failed() {
  local ssh_target="$1" desk_name="$2"
  if ssh -o BatchMode=yes "$ssh_target" 'test -f /var/lib/openclaw/provision-failed' 2>/dev/null; then
    echo >&2
    echo "WARNING: \"$desk_name\" left /var/lib/openclaw/provision-failed behind — part of first boot failed (managed Chromium, or the fork checkout). The Gateway is up, but browser Duties will fail until it is fixed. Check: ssh ${ssh_target} journalctl -u cloud-init-output --no-pager" >&2
  fi
}

# The lines every create script prints once a desk answers: where to open it and how to get the
# first sign-in token. `ssh -t` (the Gateway refuses to print its token without a TTY on both
# ends) and `sudo -H` (so the CLI reads the service user's own ~/.openclaw, not root's) are both
# required — without either, this very first operator step fails.
desk_print_ready() {
  local desk_name="$1" control_ui_url="$2" ssh_target="$3" profile="$4"
  echo
  echo "Desk \"$desk_name\" is up."
  echo "Control UI: ${control_ui_url}"
  echo "Sign in:    ssh -t ${ssh_target} 'sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'"
  if [[ "$profile" == "client" ]]; then
    # Nothing is configured beyond desk plumbing on a client desk, so say where the client picks
    # up rather than leaving a Control UI that looks half-finished.
    echo
    echo "Client desk: the Control UI opens on the same onboarding a fresh install shows."
    echo "  1. Model Setup - connect Claude by signing in."
    echo "  2. First conversation - name the assistant when it asks."
    echo "  3. Settings > Telegram - paste a BotFather token to add Telegram."
    echo "See deploy/desk/README.md (\"Client desk\") for what to hand over."
  fi
}
