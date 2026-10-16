# Pairs this VM's own desktop node with the Gateway running on it, through the Gateway's managed
# Tailscale ingress (https://<tailnet-host>), the same path every other node uses. Runs over SSH
# as vasudev with a JSON document on stdin: tailnetHost, gatewayAdminPassword, displayName.
# `connect --service` redeems the join URL and installs the "OpenClaw Node" logon task; the
# device and the node's command surface are then approved from the desk CLI on the same box.
# Exit 7 = the ingress does not answer from here (see windows-desk-runbook.md, "Loopback
# entrance fallback"); exit 8 = the node came up without the three commands the desk needs.
$ErrorActionPreference = "Stop"
$params = [Console]::In.ReadToEnd() | ConvertFrom-Json
$cli = "C:\opt\openclaw\dist\index.js"
$pw = $params.gatewayAdminPassword
$ingress = "https://$($params.tailnetHost)"
try { $null = Invoke-WebRequest -UseBasicParsing -Uri "$ingress/healthz" -TimeoutSec 10 } catch { "pair-node: ingress-unreachable $ingress"; exit 7 }

node $cli plugins enable cua-computer | Out-Null
$join = node $cli devices join-code --json --password $pw | ConvertFrom-Json
if (-not $join.joinUrl) { "pair-node: no join url from devices join-code"; exit 1 }
# The join URL names the ts.net ingress; connect --service installs the logon task and starts it.
node $cli connect $join.joinUrl --service --display-name $params.displayName
if ($LASTEXITCODE -ne 0) { "pair-node: connect failed ($LASTEXITCODE)"; exit 1 }

# Approvals: first the device (pairing request), then the node's command surface. Each list is
# polled briefly because the node registers a moment after connect returns.
function Approve-Pending([string]$what) {
  for ($i = 0; $i -lt 12; $i++) {
    $items = @()
    if ($what -eq "devices") {
      $list = node $cli devices list --json --password $pw | ConvertFrom-Json
      $items = @($list.pending)
    } else {
      $items = @(node $cli nodes pending --json --password $pw | ConvertFrom-Json)
    }
    if ($items.Count -gt 0) {
      foreach ($item in $items) {
        $id = if ($item.requestId) { $item.requestId } else { $item.id }
        if ($what -eq "devices") { node $cli devices approve $id --password $pw | Out-Null }
        else { node $cli nodes approve $id --password $pw | Out-Null }
      }
      return $true
    }
    Start-Sleep -Seconds 5
  }
  return $false
}
$null = Approve-Pending "devices"
$null = Approve-Pending "nodes"

Start-Sleep -Seconds 15
$status = node $cli nodes status --json --password $pw | ConvertFrom-Json
$node = @($status.nodes) | Where-Object { $_.displayName -eq $params.displayName } | Select-Object -First 1
$cmds = @($node.commands)
foreach ($c in "computer.act", "screen.snapshot", "desktop.stream") {
  if ($cmds -notcontains $c) { "pair-node: $c not advertised (have: $($cmds -join ','))"; exit 8 }
}
"pair-node: ok"
