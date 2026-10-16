# One health line for an Azure Windows desk (operator check; the Duties page's Desk card does not
# read it yet - follow-up). Every reading is taken before any verdict; the exit code is the
# conjunction of the booleans so the create script and the reboot test can gate on it.
# Usage: desk-health.ps1 [-WhitelistAddresses a,b,c]
#   GATEWAY_ADMIN_PASSWORD in the environment overrides C:\opt\secrets\gateway-admin-password.
param([string[]]$WhitelistAddresses = @())
$ErrorActionPreference = "Continue"
# `powershell -File x.ps1 -WhitelistAddresses a,b` delivers one string; split it here.
$WhitelistAddresses = @($WhitelistAddresses | ForEach-Object { $_ -split "," } | Where-Object { $_ })
$cli = "C:\opt\openclaw\dist\index.js"
$ts = "C:\Program Files\Tailscale\tailscale.exe"
$pw = if ($env:GATEWAY_ADMIN_PASSWORD) { $env:GATEWAY_ADMIN_PASSWORD } else { (Get-Content "C:\opt\secrets\gateway-admin-password" -Raw).Trim() }
function Get-HttpStatus([string]$url, [hashtable]$headers = @{}) {
  try { return (Invoke-WebRequest -UseBasicParsing -Uri $url -Headers $headers -TimeoutSec 5).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return 0 } }
}

$gateway = (Get-HttpStatus "http://127.0.0.1:18789/healthz") -eq 200
$status = $null
try { $status = node $cli nodes status --json --password $pw 2>$null | ConvertFrom-Json } catch { $status = $null }
# The desktop node is the connected one that carries all three commands (a paired laptop browser
# node on the same Gateway must not be mistaken for it).
$node = @($status.nodes) | Where-Object { $_.connected -and (@($_.commands) -contains "computer.act") -and (@($_.commands) -contains "screen.snapshot") -and (@($_.commands) -contains "desktop.stream") } | Select-Object -First 1
$nodeCommands = @($node.commands)
$nodeOk = $null -ne $node
$vncListeners = @(Get-NetTCPConnection -State Listen -LocalPort 5900 -ErrorAction SilentlyContinue)
$vnc = $vncListeners.Count -gt 0
$vncLoopbackOnly = $vnc -and (@($vncListeners | Where-Object { $_.LocalAddress -ne "127.0.0.1" }).Count -eq 0)
# The desktop is usable only when vasudev holds the CONSOLE session in the Active state: a
# disconnected RDP session ("Disc") or a session on another station has no desktop to drive.
$sessionLine = query user 2>$null | Select-String "^\s*>?vasudev\s" | Select-Object -First 1
# `query user` columns: USERNAME SESSIONNAME ID STATE ...; a disconnected session prints no
# SESSIONNAME at all, so the fields are matched by value rather than by position.
$sessionFields = if ($sessionLine) { @($sessionLine.ToString().TrimStart(">", " ") -split "\s+") } else { @() }
$consoleReason = if (-not $sessionLine) { "no-session" }
  elseif ($sessionFields -notcontains "console") { "not-console" }
  elseif ($sessionFields -notcontains "Active") { "disconnected" }
  elseif (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { "locked" }
  else { "ok" }
$console = $consoleReason -eq "ok"
$tsStatus = $null
try { $tsStatus = & $ts status --json 2>$null | ConvertFrom-Json } catch { $tsStatus = $null }
$tailscale = $tsStatus.BackendState -eq "Running"
$routes = @((Get-NetRoute -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -eq "Tailscale" -and $_.DestinationPrefix -like "*/32" -and $_.DestinationPrefix -notlike "100.*" }).DestinationPrefix)
$tailnetIp = (& $ts ip -4 2>$null | Select-Object -First 1)
# Caddy answers 401 to a bad basic-auth header: that proves the listener and its auth without
# needing the front password here.
$caddy = (Get-HttpStatus "http://$($tailnetIp):8443/healthz" @{ Authorization = "Basic aW52YWxpZDppbnZhbGlk" }) -eq 401
$egress = [ordered]@{}
foreach ($a in $WhitelistAddresses) {
  $hop = $null
  try { $hop = (Test-NetConnection -ComputerName $a -TraceRoute -WarningAction SilentlyContinue -ErrorAction Stop).TraceRoute | Select-Object -First 1 } catch { $hop = "error" }
  $egress[$a] = $hop
}
$load = [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$memFreeMb = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
$result = [ordered]@{
  hosted = $true; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  gateway = $gateway; node = $nodeOk; nodeCommands = $nodeCommands
  vnc = $vnc; vncLoopbackOnly = $vncLoopbackOnly
  console = $console; consoleReason = $consoleReason
  tailscale = $tailscale; routes = $routes; caddy = $caddy; egress = $egress
  load = $load; memFreeMb = $memFreeMb
}
$result | ConvertTo-Json -Compress -Depth 4
if ($gateway -and $nodeOk -and $vnc -and $vncLoopbackOnly -and $console -and $tailscale -and $caddy) { exit 0 } else { exit 1 }
