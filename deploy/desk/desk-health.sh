#!/usr/bin/env bash
set -euo pipefail
OUT=/var/lib/openclaw/desk-health.json
mkdir -p "$(dirname "$OUT")"
ok() { [ "$1" = 0 ] && echo true || echo false; }
gw=$(systemctl is-active --quiet openclaw-gateway; echo $?)
disp=$(DISPLAY=:99 xdpyinfo >/dev/null 2>&1; echo $?)
[ "$disp" != 0 ] && systemctl restart xvfb
chrome=$(pgrep -u openclaw -f "chrom(e|ium)" >/dev/null 2>&1; echo $?)
ts=$(tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; echo $?)
mail=$(pgrep -f "gog gmail watch serve" >/dev/null 2>&1; echo $?)
load1=$(cut -d' ' -f1 /proc/loadavg)
memfree=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
printf '{"hosted":true,"at":%s,"gateway":%s,"display":%s,"chromium":%s,"tailscale":%s,"mailWatcher":%s,"load1":%s,"memFreeMb":%s}\n' \
  "$(date +%s)000" "$(ok "$gw")" "$(ok "$disp")" "$(ok "$chrome")" "$(ok "$ts")" "$(ok "$mail")" "$load1" "$memfree" > "$OUT.tmp"
chmod 644 "$OUT.tmp"; mv "$OUT.tmp" "$OUT"
