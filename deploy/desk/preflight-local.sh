#!/usr/bin/env bash
# Boots the desk image locally in a Multipass Ubuntu 24.04 VM from the exact cloud-init the
# operator scripts render, so every boot step (users, write_files, Tailscale install, checkout,
# install, build, units, reboot) is exercised on the operator's machine BEFORE a droplet is paid
# for. Secrets are fixtures: the Tailscale join fails fast (the template's `--timeout`) and the
# Telegram token is fake, so the VM never touches the real tailnet or bot; everything else runs
# for real. Exit 0 = cloud-init finished with no errors and the Gateway unit answers /healthz.
#
# Usage: deploy/desk/preflight-local.sh [--git-ref <ref>] [--keep]
#   --git-ref   fork ref the VM checks out (default: the current branch name)
#   --keep      leave the VM running for inspection (default: delete it on exit)
# Env: PREFLIGHT_VM (name, default desk-preflight), PREFLIGHT_TIMEOUT_SECONDS (default 2400).
set -euo pipefail

for cmd in multipass node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "preflight-local.sh: \"$cmd\" is required but not found on PATH (brew install --cask multipass)" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
vm="${PREFLIGHT_VM:-desk-preflight}"
timeout_s="${PREFLIGHT_TIMEOUT_SECONDS:-2400}"
git_ref="$(git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
keep=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --git-ref) git_ref="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "preflight-local.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d)"
cleanup() {
  rm -rf "$work"
  if [[ "$keep" -eq 0 ]]; then
    multipass delete --purge "$vm" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

umask 077
printf 'tskey-auth-PREFLIGHT-FIXTURE-not-a-real-key\n' > "$work/ts"
printf '100000000:PREFLIGHT-FIXTURE-not-a-real-token\n' > "$work/tg"
echo "==> Rendering cloud-init (git-ref $git_ref, fixture secrets)" >&2
node "$SCRIPT_DIR/render-cloud-init.mjs" \
  --name "$vm" --ts-authkey-file "$work/ts" --tg-token-file "$work/tg" \
  --owner-target 100000000 --git-ref "$git_ref" > "$work/cloud-init.yaml"

multipass delete --purge "$vm" >/dev/null 2>&1 || true
echo "==> Launching Multipass VM \"$vm\" (Ubuntu 24.04, 2 CPU, 4G, 20G)" >&2
started=$(date +%s)
# `multipass launch` returns non-zero when its own --timeout passes before cloud-init's init
# stage completes (the fork build runs inside cloud-init, so that is expected); the instance
# keeps running, so only a missing instance is fatal here.
if ! multipass launch 24.04 --name "$vm" --cpus 2 --memory 4G --disk 20G \
  --cloud-init "$work/cloud-init.yaml" --timeout 900 >&2; then
  if ! multipass info "$vm" >/dev/null 2>&1; then
    echo "preflight-local.sh: multipass launch failed and no instance exists" >&2
    exit 5
  fi
  echo "==> launch returned early; instance exists, continuing to poll cloud-init" >&2
fi

# cloud-init reboots the VM at the end of runcmd (power_state), so poll rather than --wait.
echo "==> Waiting for cloud-init to finish (up to ${timeout_s}s; the fork build runs inside)" >&2
status=""
while :; do
  now=$(date +%s)
  elapsed=$((now - started))
  if [[ "$elapsed" -ge "$timeout_s" ]]; then
    echo "preflight-local.sh: cloud-init did not finish within ${timeout_s}s" >&2
    multipass exec "$vm" -- sudo tail -40 /var/log/cloud-init-output.log >&2 || true
    exit 4
  fi
  status="$(multipass exec "$vm" -- cloud-init status 2>/dev/null | head -1 || true)"
  case "$status" in
    *done*|*error*) break ;;
  esac
  if (( elapsed % 60 < 15 )); then
    tail_line="$(multipass exec "$vm" -- sudo tail -1 /var/log/cloud-init-output.log 2>/dev/null | cut -c1-120 || true)"
    echo "==> ${elapsed}s: ${status:-booting} ${tail_line:+| $tail_line}" >&2
  fi
  sleep 15
done

echo "==> cloud-init: $status" >&2
multipass exec "$vm" -- cloud-init status --long >&2 || true
errors="$(multipass exec "$vm" -- cloud-init status --long 2>/dev/null | sed -n '/^errors:/,/^recoverable_errors:/p' | grep -c '^\s*- ' || true)"

# The reboot at the end of runcmd: wait for the VM to come back and the units to settle.
echo "==> Waiting for the post-provision reboot and the units" >&2
for _ in $(seq 1 40); do
  if multipass exec "$vm" -- systemctl is-active xvfb openclaw-gateway >/dev/null 2>&1; then
    break
  fi
  sleep 15
done
units="$(multipass exec "$vm" -- systemctl is-active xvfb openclaw-gateway desk-health.timer 2>&1 | tr '\n' ' ')"
health="$(multipass exec "$vm" -- curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/healthz 2>/dev/null || echo 000)"
tailscale_note="$(multipass exec "$vm" -- sudo grep -c 'tailscale up FAILED' /var/log/cloud-init-output.log 2>/dev/null || echo 0)"
echo "==> units: $units" >&2
echo "==> gateway /healthz: $health (tailscale join skipped by fixture: $tailscale_note)" >&2
echo "==> journal (last 15 lines, gateway):" >&2
multipass exec "$vm" -- sudo journalctl -u openclaw-gateway -n 15 --no-pager 2>/dev/null | cut -c1-160 >&2 || true

if [[ "$errors" != "0" || "$health" != "200" ]]; then
  echo "preflight-local.sh: FAILED (cloud-init errors=$errors, healthz=$health)" >&2
  multipass exec "$vm" -- sudo tail -60 /var/log/cloud-init-output.log 2>/dev/null | cut -c1-200 >&2 || true
  exit 1
fi
echo "preflight-local.sh: OK in $(( $(date +%s) - started ))s" >&2
