# Pairs this VM's own desktop node with the Gateway running on it, through the Gateway's managed
# Tailscale ingress (https://<tailnet-host>), the same path every other node uses. Runs over SSH
# as vasudev with a JSON document on stdin: tailnetHost, gatewayAdminPassword, displayName.
#
# Sequence proved live on 2026-10-16: `connect --service` connects, asks the Gateway for the node
# role and blocks ("role upgrade pending approval"); that request shows in `devices list` only while
# the node is connected. After the device approval the node reconnects (or `connect` has given up
# and is started again), and the node's command surface then appears in `nodes pending`. Once that
# is approved, `connect --service` installs the "OpenClaw Node" logon task and the node advertises
# its commands. The devices commands take --password (trusted-proxy desk); the nodes commands use
# the CLI's own silently-approved device token and take none.
# Exit 7 = the ingress does not answer from here (see windows-desk-runbook.md, "Loopback
# entrance fallback"); exit 8 = the node never came up with the three commands the desk needs.
$ErrorActionPreference = "Stop"
$params = [Console]::In.ReadToEnd() | ConvertFrom-Json
$cli = "C:\opt\openclaw\dist\index.js"
$pw = $params.gatewayAdminPassword
$ingress = "https://$($params.tailnetHost)"
$tailnetIp = (& "C:\Program Files\Tailscale\tailscale.exe" ip -4).Trim()
try { $null = Invoke-WebRequest -UseBasicParsing -Uri "$ingress/healthz" -TimeoutSec 10 } catch { "pair-node: ingress-unreachable $ingress"; exit 7 }

node $cli plugins enable cua-computer | Out-Null
$join = node $cli devices join-code --json --password $pw 2>$null | ConvertFrom-Json
if (-not $join.joinUrl) { "pair-node: no join url from devices join-code"; exit 1 }

$connectLog = "C:\opt\stage\connect.log"
function Start-Connect {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*index.js connect *" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  return Start-Process node -ArgumentList @($cli, "connect", $join.joinUrl, "--service", "--display-name", "`"$($params.displayName)`"") -WindowStyle Hidden -PassThru -RedirectStandardOutput $connectLog -RedirectStandardError "$connectLog.err"
}
function Get-NodeState {
  $st = $null
  try { $st = node $cli nodes status --json 2>$null | ConvertFrom-Json } catch { return $null }
  return @($st.nodes) | Where-Object { $_.displayName -eq $params.displayName -or $_.clientId -eq "node-host" } | Select-Object -First 1
}
$connect = Start-Connect
$deviceApproved = $false
$nodeApproved = $false
for ($i = 0; $i -lt 36; $i++) {
  Start-Sleep -Seconds 5
  if (-not $deviceApproved) {
    $list = $null
    try { $list = node $cli devices list --json --password $pw 2>$null | ConvertFrom-Json } catch { $list = $null }
    # Only this VM's own node: a request from any other address is someone else's and is left
    # for the operator (a rerun on a Gateway with a foreign pending node must not adopt it).
    foreach ($p in @($list.pending)) {
      if ($p.clientMode -eq "node" -and $p.remoteIp -in @("127.0.0.1", "::1", $tailnetIp)) {
        node $cli devices approve $p.requestId --password $pw 2>&1 | Out-Null
        "pair-node: approved device request $($p.requestId)"
        $deviceApproved = $true
      }
    }
  }
  if (-not $nodeApproved) {
    $np = @()
    try { $np = @(node $cli nodes pending --json 2>$null | ConvertFrom-Json) } catch { $np = @() }
    foreach ($p in $np) {
      if ($p.requestId -and $p.displayName -eq $params.displayName) {
        node $cli nodes approve $p.requestId 2>&1 | Out-Null
        "pair-node: approved node request $($p.requestId)"
        $nodeApproved = $true
      }
    }
  }
  $n = Get-NodeState
  if ($n -and $n.connected -and $n.approvalState -eq "approved") { break }
  # connect gives up after a refused attempt; start it again so the next request is raised.
  if ($connect.HasExited -and -not ($n -and $n.connected)) { $connect = Start-Connect }
}
Start-Sleep -Seconds 10
$n = Get-NodeState
$cmds = @($n.commands)
foreach ($c in "computer.act", "screen.snapshot", "desktop.stream") {
  if ($cmds -notcontains $c) { "pair-node: $c not advertised (have: $($cmds -join ','))"; exit 8 }
}
if (-not (Get-ScheduledTask -TaskName "OpenClaw Node" -ErrorAction SilentlyContinue)) { "pair-node: the OpenClaw Node task was not installed"; exit 8 }
"pair-node: ok"
