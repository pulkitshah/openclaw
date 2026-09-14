#!/usr/bin/env bash
# Runs ON a hosted desk, fed to `bash -s --` over SSH by deploy/desk/roll.sh (never invoked
# directly by an operator). It lives in the tree — rather than inside roll.sh as a heredoc — so it
# can be executed and asserted on for real: deploy/desk/scripts.test.ts runs this exact file
# against a temp checkout with stubbed git/pnpm/systemctl/curl, which is the only way the recovery
# branch below (the one branch that runs on a live client desk after a failed roll) gets execution
# proof instead of string matching. The operator's checkout ships it, so `roll.sh` always has it.
#
# Usage (positional, all four required): roll-remote.sh <desk-name> <git-ref> <gateway-port> <mode>
#   <mode> is "restart" (start the Gateway again here) or "reboot" (reboot the box instead).
# Exit codes: 5 = roll failed, previous build restored and the Gateway is back up; 6 = roll failed
# and the Gateway would not come back even on the restored build; 1 = the new build came up but
# never answered /healthz.
set -euo pipefail

desk_name="${1:?roll-remote.sh: missing <desk-name>}"
git_ref="${2:?roll-remote.sh: missing <git-ref>}"
gateway_port="${3:?roll-remote.sh: missing <gateway-port>}"
mode="${4:?roll-remote.sh: missing <mode>}"

# The checkout this rolls. A desk never sets these three: they exist so the test can point the
# script at a temp tree and shrink the 120 s health wait, the same test-only-knob pattern
# new-desk.sh uses for its own poll interval.
root="${OPENCLAW_DESK_ROOT:-/opt/openclaw}"
health_attempts="${OPENCLAW_DESK_HEALTH_ATTEMPTS:-60}"
health_interval="${OPENCLAW_DESK_HEALTH_INTERVAL_SECONDS:-2}"

cd "$root"

# Snapshot the current build and its git ref BEFORE touching anything else, so a roll that
# fails partway through fetch/install/build can put the desk back exactly as it was serving
# rather than leaving it down indefinitely (a frozen-lockfile install can fail on a network
# hiccup; this project's own live proof once OOM'd mid-`pnpm build`). Guarded on dist existing
# so this is a no-op on a desk that has literally never built (should not happen in practice —
# cloud-init's own first boot already produced one — but this must never itself be the reason a
# roll aborts before the Gateway is even stopped).
rm -rf "$root/dist.prev"
if [ -d "$root/dist" ]; then
  cp -a "$root/dist" "$root/dist.prev"
fi
git rev-parse HEAD > "$root/dist.prev.ref"

wait_healthy() {
  for _ in $(seq 1 "$health_attempts"); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${gateway_port}/healthz"; then
      return 0
    fi
    sleep "$health_interval"
  done
  return 1
}

# Reverses the snapshot above: dist.prev back to dist, the checkout back to the ref that produced
# it, that ref's own dependency tree reinstalled, ownership restored — the same state the last
# successful roll left. `pnpm install` is part of the restore because the failure this exists for
# lands AFTER the forward install has already replaced node_modules with the NEW ref's dependency
# tree (an OOM'd build is the measured case), and the old dist must not run against those:
# --prefer-offline so the restore reuses the local store instead of depending on the network that
# may itself be what failed. Guarded with `|| true` at every call site below, which (bash
# suspends errexit for the whole body of a function used as an `&&`/`||` operand) also means one
# failing step here does not skip the rest — a restore step failing must never stop this script
# from at least attempting to bring the Gateway back up (the exit-6 path below is exactly for
# "even the restore/restart failed").
restore_previous_build() {
  rm -rf "$root/dist"
  if [ -d "$root/dist.prev" ]; then
    mv "$root/dist.prev" "$root/dist"
  fi
  git checkout --detach "$(cat "$root/dist.prev.ref")"
  npm_config_minimum_release_age=0 npm_config_minimum_release_age_strict=false pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
  chown -R root:openclaw "$root"
  chmod -R g+rX,o-rwx "$root"
}

# Stop the Gateway BEFORE the checkout/install/build so a live process is never rebuilt out
# from under itself (was: rebuilding dist while the old Gateway kept serving, surfacing a
# transient "assets could not be prepared" and skills EACCES on the Control UI mid-roll). The
# desk is down and Duties are refused for the whole build below, until the Gateway starts again.
systemctl stop openclaw-gateway
echo "updating ${desk_name}: Gateway stopped, building…"

# Each step guards its own failure with `||` instead of leaning on `set -e` inside the function
# body: a function invoked as an `if` condition runs with `-e` suspended for its ENTIRE body in
# bash, so without this, a failed `git fetch` would not stop `git checkout`/`pnpm
# install`/`pnpm build` from still running on top of it — this makes the function actually stop
# at the first failure, and records which step that was for the message below.
build_step=""
build_new_ref() {
  build_step="git fetch"
  git fetch origin "$git_ref" || return 1
  build_step="git checkout"
  git checkout --detach FETCH_HEAD || return 1
  build_step="pnpm install"
  npm_config_minimum_release_age=0 npm_config_minimum_release_age_strict=false pnpm install --frozen-lockfile --ignore-scripts || return 1
  build_step="pnpm build"
  # Runtime-only build with the explicit heap override — the SAME mode and ceiling cloud-init's
  # own first-boot build uses. The full build emits declarations, which this project measured as
  # needing ~4.7 GB and refusing outright on the documented default 4 GB desk, so a plain `pnpm
  # build` here made every roll of a default-size desk fail deterministically. The desk only ever
  # runs the Gateway, so it never needs the .d.ts pass.
  OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352 pnpm build || return 1
}

if ! build_new_ref; then
  echo "desk: roll failed at ${build_step} for git-ref ${git_ref}; restoring the previous build" >&2
  restore_previous_build || true
  systemctl start openclaw-gateway || true
  if wait_healthy; then
    echo "roll FAILED at ${build_step}; previous build restored and Gateway restarted" >&2
    exit 5
  fi
  echo "roll FAILED at ${build_step}; previous build restored but Gateway did not answer /healthz within 120s — check: ssh root@${desk_name} journalctl -u openclaw-gateway -u cloud-init-output --no-pager" >&2
  exit 6
fi

chown -R root:openclaw "$root"
chmod -R g+rX,o-rwx "$root"
# The new build is in place and ownership is restored; the snapshot is no longer needed.
rm -rf "$root/dist.prev" "$root/dist.prev.ref"

if [ "$mode" = "reboot" ]; then
  systemctl reboot
  exit 0
fi
systemctl start openclaw-gateway
if ! wait_healthy; then
  echo "openclaw-gateway did not answer /healthz on port ${gateway_port} within 120s" >&2
  exit 1
fi
sudo -H -u openclaw node "$root/openclaw.mjs" --version
