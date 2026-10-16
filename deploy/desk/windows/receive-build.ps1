# Receives a tar of dist/ on stdin (from push-build.sh), extracts it to C:\opt\openclaw\dist, and
# confirms the file count and manifest hash the sender computed before swapping it in. The
# plugin node_modules that `pnpm install` created on this VM are kept; everything else is replaced.
# -ManifestOnly <dir> prints the manifest of an existing directory and exits (the parity test on
# the Mac runs it under pwsh against push-build.sh's bash computation).
param(
  [string]$GitRef,
  [int]$ExpectedCount,
  [string]$ExpectedManifest,
  [string]$ManifestOnly
)
$ErrorActionPreference = "Stop"
# Same line format as the sender ("<sha256>  ./<path>"), ORDINAL (bytewise) order like
# `LC_ALL=C sort`, hashed once more. Sort-Object -Culture "" is linguistic and case-insensitive
# and disagrees with the sender on tsdown's mixed-case chunk names; [StringComparer]::Ordinal
# does not.
function Get-DistManifest([string]$root) {
  $files = Get-ChildItem -Path $root -Recurse -File -Force | Where-Object { $_.FullName -notmatch '[\\/]extensions[\\/][^\\/]+[\\/]node_modules[\\/]' }
  $items = @{}
  foreach ($f in $files) {
    $rel = "." + $f.FullName.Substring($root.TrimEnd('\', '/').Length).Replace('\', '/')
    $items[$rel] = $f.FullName
  }
  $rels = [string[]]@($items.Keys)
  [Array]::Sort($rels, [StringComparer]::Ordinal)
  $lines = foreach ($rel in $rels) { "$((Get-FileHash $items[$rel] -Algorithm SHA256).Hash.ToLower())  $rel" }
  $sha = [Security.Cryptography.SHA256]::Create()
  $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes(($lines -join "`n") + "`n"))).Replace('-', '').ToLower()
  return @{ count = $rels.Count; manifest = $digest }
}
if ($ManifestOnly) {
  $m = Get-DistManifest (Resolve-Path $ManifestOnly).Path
  "$($m.manifest) $($m.count)"
  exit 0
}
if (-not $GitRef -or -not $ExpectedCount -or -not $ExpectedManifest) { "receive-build: GitRef, ExpectedCount and ExpectedManifest are required"; exit 2 }
$dist = "C:\opt\openclaw\dist"; $tmp = "C:\opt\dist-incoming"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$tarPath = "$tmp.tar"
$stdin = [Console]::OpenStandardInput()
$fs = [IO.File]::Create($tarPath)
$stdin.CopyTo($fs)
$fs.Close()
tar.exe -xf $tarPath -C $tmp
Remove-Item $tarPath
$m = Get-DistManifest $tmp
if ($m.count -ne $ExpectedCount) { "receive-build: count mismatch $($m.count) != $ExpectedCount"; exit 1 }
if ($m.manifest -ne $ExpectedManifest) { "receive-build: manifest mismatch $($m.manifest) != $ExpectedManifest"; exit 1 }
if (Test-Path $dist) {
  Get-ChildItem $dist | Where-Object Name -ne "extensions" | Remove-Item -Recurse -Force
  Get-ChildItem "$dist\extensions" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Get-ChildItem $_.FullName | Where-Object Name -ne "node_modules" | Remove-Item -Recurse -Force
  }
}
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item -Path "$tmp\*" -Destination $dist -Recurse -Force
Remove-Item -Recurse -Force $tmp
Set-Content -Path "$dist\.provision-built-ref" -Value $GitRef -NoNewline -Encoding ascii
"receive-build: ok $($m.count) files"
