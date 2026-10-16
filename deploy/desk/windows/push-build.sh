#!/usr/bin/env bash
# Pushes this checkout's runtime build to a Windows desk over SSH. dist/ is one unit (plugin bundles
# import hashed chunks from the parent dist; see office-pc-runbook.md §10.7), so the whole tree
# goes every time, excluding the per-plugin node_modules that `pnpm install` on the VM owns.
# Builds first when dist/.provision-built-ref is not the requested commit. A 2-vCPU VM should
# never run tsdown itself (4.3 GB heap, hours on the office PC).
set -euo pipefail
host="${1:?usage: push-build.sh <tailnet-host> [--git-ref <sha>]}"
shift
git_ref=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --git-ref) git_ref="$2"; shift 2 ;;
    *)
      echo "push-build.sh: unknown option $1" >&2
      exit 2
      ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$SCRIPT_DIR/../../.." && pwd)"
dist="${DESK_BUILD_DIR:-$repo/dist}"
git_ref="${git_ref:-$(git -C "$repo" rev-parse HEAD)}"
if [[ "$(git -C "$repo" rev-parse HEAD)" != "$git_ref" ]]; then
  echo "push-build.sh: this checkout is at $(git -C "$repo" rev-parse --short HEAD), not ${git_ref:0:11} — check out the commit to push first" >&2
  exit 1
fi
if [[ ! -f "$dist/.provision-built-ref" || "$(cat "$dist/.provision-built-ref")" != "$git_ref" ]]; then
  echo "==> Building dist for ${git_ref:0:11}" >&2
  (cd "$repo" && OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=4352 pnpm build)
  printf '%s\n' "$git_ref" > "$dist/.provision-built-ref"
fi
# The manifest is "<sha256>  ./<path>" per file, bytewise-sorted, hashed once more; the receiver
# recomputes it the same way so a truncated tar, a CRLF-converted file or a stray plugin
# node_modules fails loudly instead of leaving a node that silently stops advertising a command.
manifest="$(cd "$dist" && find . -type f -not -path './extensions/*/node_modules/*' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1)"
count="$(cd "$dist" && find . -type f -not -path './extensions/*/node_modules/*' | wc -l | tr -d ' ')"
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts_vasudev_desks")
# Binary data does not survive Windows OpenSSH's stdin (observed live 2026-10-16: a 262 MB tar
# stalled after 128 KB, both through PowerShell and straight into tar.exe), so the tar and the
# receiver script go up with sftp, which uses its own channel, and the receiver reads the tar
# from disk.
tarfile="$(mktemp -t vasudev-dist).tar"
trap 'rm -f "$tarfile"' EXIT
# bsdtar on macOS adds AppleDouble ._* entries for files with extended attributes unless told not
# to; tar.exe on the VM would extract them as real files and the count would disagree.
COPYFILE_DISABLE=1 tar -C "$dist" --no-mac-metadata --no-xattrs --exclude='./extensions/*/node_modules' -cf "$tarfile" .
echo "==> Uploading ${count} files ($(du -h "$tarfile" | cut -f1 | tr -d ' ')) to ${host} with sftp" >&2
printf 'mkdir /C:/opt/stage\nput %s /C:/opt/stage/receive-build.ps1\nput %s /C:/opt/dist-incoming.tar\nquit\n' "$SCRIPT_DIR/receive-build.ps1" "$tarfile" \
  | sftp -b - "${ssh_opts[@]}" "vasudev@${host}" >/dev/null
out="$(ssh "${ssh_opts[@]}" "vasudev@${host}" "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\opt\\stage\\receive-build.ps1 -TarPath C:\\opt\\dist-incoming.tar -GitRef ${git_ref} -ExpectedCount ${count} -ExpectedManifest ${manifest}" | tr -d '\r')"
printf '%s\n' "$out" >&2
if ! printf '%s' "$out" | grep -q '^receive-build: ok'; then
  echo "push-build.sh: the VM did not confirm the build" >&2
  exit 1
fi
echo "push-build: ok ${git_ref} ${count}"
