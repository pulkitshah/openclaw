# Provisions the Vasudev desk on a Windows VM that finished first-boot.ps1: fork checkout at the
# pinned commit, pnpm install (native platform packages), desk config from the template, secrets,
# the Gateway as the fork's managed scheduled task, and a Caddy round-trip. Runs over SSH as
# vasudev with a JSON document on stdin (gitRef, forkRepoUrl, ownerEmail, gatewayAdminPassword,
# frontPassword, tailnetHost, tailnetIp, frontDoorOrigin, clientName). dist/ arrives separately
# (push-build.sh) and must already match gitRef.
$ErrorActionPreference = "Stop"
$params = [Console]::In.ReadToEnd() | ConvertFrom-Json
$root = "C:\opt\openclaw"; $secrets = "C:\opt\secrets"; $state = "$env:USERPROFILE\.openclaw"
New-Item -ItemType Directory -Force -Path $secrets, $state | Out-Null
icacls $secrets /inheritance:r /grant "vasudev:(OI)(CI)F" /grant "SYSTEM:(OI)(CI)F" | Out-Null

# 1. Checkout at the pinned commit (shallow; the build itself comes from the Mac). push-build.sh
#    has already filled C:\opt\openclaw\dist, so this is init + fetch into a non-empty directory,
#    never `git clone`, which refuses one. dist/ is git-ignored by the checkout.
function Assert-Native([string]$what) { if ($LASTEXITCODE -ne 0) { "provision-desk: $what failed ($LASTEXITCODE)"; exit 4 } }
if (-not (Test-Path "$root\.git")) {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  git -C $root init -q
  Assert-Native "git init"
  git -C $root remote add origin $params.forkRepoUrl
  Assert-Native "git remote add"
}
git -C $root config core.autocrlf false
git -C $root fetch --depth 1 origin $params.gitRef
Assert-Native "git fetch $($params.gitRef) (is the commit pushed to the fork?)"
git -C $root checkout -q --detach FETCH_HEAD
Assert-Native "git checkout"

# 2. pnpm pinned by the checkout, then the runtime dependencies (native win32 packages included).
$pm = node -p "require('$($root.Replace('\', '/'))/package.json').packageManager"
Assert-Native "reading packageManager"
corepack prepare $pm --activate | Out-Null
Assert-Native "corepack prepare $pm"
Push-Location $root
$env:npm_config_minimum_release_age = "0"
$env:npm_config_minimum_release_age_strict = "false"
$env:npm_config_fetch_timeout = "900000"
pnpm install --frozen-lockfile --ignore-scripts
$installExit = $LASTEXITCODE
Pop-Location
if ($installExit -ne 0) { "provision-desk: pnpm install failed ($installExit)"; exit 4 }
$builtRef = if (Test-Path "$root\dist\.provision-built-ref") { (Get-Content "$root\dist\.provision-built-ref" -Raw).Trim() } else { "" }
if ($builtRef -ne $params.gitRef) {
  "provision-desk: dist is not built for $($params.gitRef) (have '$builtRef') - run deploy/desk/windows/push-build.sh first"
  exit 4
}

# 3. Secrets, then the config from the template.
Set-Content -Path "$secrets\gateway-admin-password" -Value $params.gatewayAdminPassword -NoNewline -Encoding ascii
$tmpl = @'
{{CONFIG_TMPL}}
'@
$config = $tmpl.Replace("{{OWNER_EMAIL}}", $params.ownerEmail).Replace("{{TAILNET_HOST}}", $params.tailnetHost).Replace("{{FRONT_DOOR_ORIGIN}}", $params.frontDoorOrigin)
Set-Content -Path "$state\openclaw.json" -Value $config -Encoding ascii
node "$root\dist\index.js" config validate
if ($LASTEXITCODE -ne 0) { "provision-desk: config validate failed"; exit 4 }

# 4. Gateway as the managed scheduled task, then wait for it.
node "$root\dist\index.js" gateway install --force
if ($LASTEXITCODE -ne 0) { "provision-desk: gateway install failed"; exit 5 }
$deadline = (Get-Date).AddMinutes(5)
$ok = $false
do {
  Start-Sleep -Seconds 5
  try { $ok = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:18789/healthz" -TimeoutSec 5).StatusCode -eq 200 } catch { $ok = $false }
} until ($ok -or (Get-Date) -gt $deadline)
if (-not $ok) {
  "provision-desk: gateway did not answer /healthz in 5 minutes"
  node "$root\dist\index.js" gateway status --json
  exit 5
}

# 5. Caddy round-trip from this box with the front password: proves the basic-auth listener and
#    the upstream end to end (the WebSocket login is what the front door needs; /healthz through
#    Caddy proves the listener and the upstream).
$pair = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($params.ownerEmail):$($params.frontPassword)"))
$resp = Invoke-WebRequest -UseBasicParsing -Uri "http://$($params.tailnetIp):8443/healthz" -Headers @{ Authorization = "Basic $pair" } -TimeoutSec 10
if ($resp.StatusCode -ne 200) { "provision-desk: caddy returned $($resp.StatusCode)"; exit 6 }
"provision-desk: ok"
