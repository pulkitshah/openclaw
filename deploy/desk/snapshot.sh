#!/usr/bin/env bash
# Snapshots a hosted desk's droplet and prunes old snapshots for it. See docs/superpowers/specs/
# 2026-09-14-hosted-desk-design.md §9 (ops: snapshots, retention 4).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: snapshot.sh <desk-name>

Takes a DigitalOcean snapshot of the desk's droplet, named desk-<desk-name>-<timestamp>, and
deletes older desk-<desk-name>-* snapshots beyond the newest DESK_SNAPSHOT_KEEP (default 4).

Environment overrides:
  DESK_SNAPSHOT_KEEP   how many snapshots to retain per desk (default: 4)
EOF
}

for cmd in doctl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "snapshot.sh: \"$cmd\" is required but not found on PATH — see deploy/desk/README.md (Prerequisites)" >&2
    exit 1
  fi
done

KEEP="${DESK_SNAPSHOT_KEEP:-4}"

desk_name="${1:-}"
if [[ "$desk_name" == "-h" || "$desk_name" == "--help" ]]; then
  usage
  exit 0
fi
if [[ -z "$desk_name" ]]; then
  usage >&2
  exit 2
fi

echo "==> Looking up droplet \"$desk_name\"" >&2
# jq takes the first match itself instead of piping through `head -n1` — see new-desk.sh's
# SSH-key lookup for why `cmd | jq ... | head -n1` risks a SIGPIPE-triggered abort under
# `set -o pipefail` when more than one row matches.
droplet_id="$(
  doctl compute droplet list -o json \
    | jq -r --arg name "$desk_name" '[.[] | select(.name == $name)] | (.[0].id // empty)'
)"
if [[ -z "$droplet_id" ]]; then
  echo "snapshot.sh: no droplet named \"$desk_name\"" >&2
  exit 1
fi

snapshot_name="desk-${desk_name}-$(date -u +%Y%m%d%H%M%S)"
echo "==> Snapshotting droplet $droplet_id as \"$snapshot_name\" (this can take several minutes)" >&2
doctl compute droplet-action snapshot "$droplet_id" --snapshot-name "$snapshot_name" --wait

echo "==> Pruning old snapshots for \"$desk_name\", keeping the newest $KEEP" >&2
prefix="desk-${desk_name}-"
old_snapshot_ids=()
while IFS= read -r id; do
  [[ -n "$id" ]] && old_snapshot_ids+=("$id")
done < <(
  doctl compute snapshot list --resource droplet -o json \
    | jq -r --arg prefix "$prefix" --argjson keep "$KEEP" '
        [.[] | select(.name | startswith($prefix))]
        | sort_by(.created_at)
        | reverse
        | .[$keep:]
        | .[].id
      '
)

if [[ "${#old_snapshot_ids[@]}" -gt 0 ]]; then
  for id in "${old_snapshot_ids[@]}"; do
    echo "==> Deleting old snapshot $id" >&2
    doctl compute snapshot delete "$id" --force
  done
else
  echo "==> Nothing to prune" >&2
fi

echo "Snapshot \"$snapshot_name\" created."
