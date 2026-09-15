#!/usr/bin/env bash
# Writes the one health file the Duties page's Desk card and `duties.desk.status` read
# (spec §4.8/§8). Run every two minutes by desk-health.timer, as root.
#
# Ordering rule: every reading is taken and the JSON is WRITTEN before any repair is attempted.
# `systemctl restart xvfb` failing used to abort the script (under `set -e`, as the final command
# of an `&&` list) before it ever wrote the file — so in the one situation the file exists to
# report, "the display is down and cannot be brought back", it was left holding the last
# successful reading and the card showed stale green chips forever. The restart is now last and
# cannot affect the file; `at` is always stamped, so a reader can tell a stale file from a fresh
# one.
set -euo pipefail
OUT=/var/lib/openclaw/desk-health.json
mkdir -p "$(dirname "$OUT")"
ok() { [ "$1" = 0 ] && echo true || echo false; }
gw=$(systemctl is-active --quiet openclaw-gateway; echo $?)
disp=$(DISPLAY=:99 xdpyinfo >/dev/null 2>&1; echo $?)
# "chromium" means Chromium is INSTALLED for the service user, not that a run currently has one
# open — a run-only "chromium" chip is only ever true while a Duty run holds a browser tab, so
# "all chips green" was unreachable at idle by construction. The Playwright-managed browser
# cloud-init installs (`npx playwright install chromium` as openclaw) lands under
# ~openclaw/.cache/ms-playwright/chromium-<rev>/; its presence is a fixed installation fact.
chrome=$(ls -d /home/openclaw/.cache/ms-playwright/chromium-* >/dev/null 2>&1; echo $?)
ts=$(tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; echo $?)
# Gmail hooks are owner-profile only (see the {{#IF:GMAIL_HOOKS}} section in cloud-init.yaml.tmpl);
# a client desk never renders /etc/openclaw/secrets/hooks-token.env, so `mailWatcher` would
# otherwise report `false` forever for a check nothing on that desk is meant to satisfy. Omit the
# field entirely rather than publish a permanent, unactionable failure.
if [ -f /etc/openclaw/secrets/hooks-token.env ]; then
  mail=$(pgrep -f "gog gmail watch serve" >/dev/null 2>&1; echo $?)
  mail_field="\"mailWatcher\":$(ok "$mail"),"
else
  mail_field=""
fi
# First boot left a marker behind (the fork checkout, the Claude CLI install, or the managed
# Chromium install failed). Such a desk still answers /healthz, so without this the failure only
# surfaced later as a browser step dying mid-Duty. Inverted here: 0 = marker present = NOT
# provisioned.
prov=$(test ! -f /var/lib/openclaw/provision-failed; echo $?)
load1=$(cut -d' ' -f1 /proc/loadavg)
memfree=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
printf '{"hosted":true,"at":%s,"provisioned":%s,"gateway":%s,"display":%s,"chromium":%s,"tailscale":%s,%s"load1":%s,"memFreeMb":%s}\n' \
  "$(date +%s)000" "$(ok "$prov")" "$(ok "$gw")" "$(ok "$disp")" "$(ok "$chrome")" "$(ok "$ts")" "$mail_field" "$load1" "$memfree" > "$OUT.tmp"
chmod 644 "$OUT.tmp"; mv "$OUT.tmp" "$OUT"

# Repair last, and never fatal: the reading above is already published, so a failing restart
# leaves a file that truthfully reports `display: false` with a fresh `at` instead of no update
# at all.
# An `if` rather than `[ … ] && …`: as the last command of the script that `&&` list returning
# non-zero (display fine, nothing to restart) would itself exit the script non-zero under `set -e`
# and make every healthy run look like a failed timer unit.
if [ "$disp" != 0 ]; then
  systemctl restart xvfb || true
fi
exit 0
