# Receives a tar of dist/ on stdin (from push-build.sh), extracts it to C:\opt\openclaw\dist, and
# confirms the file count and manifest hash the sender computed before swapping it in. The
# plugin node_modules that `pnpm install` created on this VM are kept; everything else is replaced.
param(
  [Parameter(Mandatory = $true)][string]$GitRef,
  [Parameter(Mandatory = $true)][int]$ExpectedCount,
  [Parameter(Mandatory = $true)][string]$ExpectedManifest
)
$ErrorActionPreference = "Stop"
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
$files = Get-ChildItem -Path $tmp -Recurse -File | Where-Object { $_.FullName -notmatch '\\extensions\\[^\\]+\\node_modules\\' }
if ($files.Count -ne $ExpectedCount) { "receive-build: count mismatch $($files.Count) != $ExpectedCount"; exit 1 }
# Same line format as the sender ("<sha256>  ./<path>"), bytewise (ordinal) order, hashed once more.
$lines = $files |
  ForEach-Object { [pscustomobject]@{ rel = "." + $_.FullName.Substring($tmp.Length).Replace('\', '/'); path = $_.FullName } } |
  Sort-Object { [string]$_.rel } -Culture "" |
  ForEach-Object { "$((Get-FileHash $_.path -Algorithm SHA256).Hash.ToLower())  $($_.rel)" }
$sha = [Security.Cryptography.SHA256]::Create()
$manifest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes(($lines -join "`n") + "`n"))).Replace('-', '').ToLower()
if ($manifest -ne $ExpectedManifest) { "receive-build: manifest mismatch $manifest != $ExpectedManifest"; exit 1 }
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
"receive-build: ok $($files.Count) files"
