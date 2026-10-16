# First boot of an Azure Windows desk. Runs over SSH as the vasudev administrator with a JSON
# document on stdin (never argv): tailnetName, tsAuthKey, adminPassword, vncPassword,
# frontPassword, ownerEmail, gitRef. Installs the pinned downloads (deploy/desk/windows/downloads.json
# is embedded below by new-desk-azure.sh as $Downloads), joins the tailnet unattended, installs
# TightVNC loopback-only, Caddy as a startup task, Node 26 + MinGit + pnpm, sets auto sign-in and
# the desk policies, then reboots into the signed-in console. Idempotent: every step checks first.
$ErrorActionPreference = "Stop"
$params = [Console]::In.ReadToEnd() | ConvertFrom-Json
$Downloads = ConvertFrom-Json @'
{{DOWNLOADS_JSON}}
'@
$opt = "C:\opt"; $dl = "C:\opt\downloads"
New-Item -ItemType Directory -Force -Path $opt, $dl, "$opt\caddy", "$opt\bin" | Out-Null

function Get-Pinned([string]$name) {
  $entry = $Downloads.$name
  $file = Join-Path $dl ([IO.Path]::GetFileName(([Uri]$entry.url).AbsolutePath))
  if (-not (Test-Path $file) -or (Get-FileHash $file -Algorithm SHA256).Hash.ToLower() -ne $entry.sha256) {
    Invoke-WebRequest -Uri $entry.url -OutFile $file -UseBasicParsing
    $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $entry.sha256) { throw "first-boot: $name sha256 mismatch ($actual)" }
  }
  return $file
}
function Install-Msi([string]$file, [string[]]$props) {
  $p = Start-Process msiexec.exe -ArgumentList (@("/i", "`"$file`"", "/quiet", "/norestart") + $props) -Wait -PassThru
  if ($p.ExitCode -notin 0, 3010) { throw "first-boot: msiexec $file exited $($p.ExitCode)" }
}

# 1. Tailscale, unattended (runs before sign-in), joins with the pre-auth key. Failure here is
#    reported and stops the script WITHOUT rebooting: the operator still has SSH on the public IP.
#    Native commands run under "Continue": with "Stop", PowerShell 5.1 turns any stderr line of a
#    `2>&1`-redirected native command into a terminating error, which would skip the marker below.
$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) { Install-Msi (Get-Pinned "tailscale") @() }
function Get-TailscaleState {
  $ErrorActionPreference = "Continue"
  try { $s = & $ts status --json 2>$null | ConvertFrom-Json; return $s.BackendState } catch { return "" }
}
if ((Get-TailscaleState) -ne "Running") {
  # The key goes through a 0600-equivalent file (`file:` reference), never argv.
  $keyFile = "$opt\ts-authkey.tmp"
  Set-Content -Path $keyFile -Value $params.tsAuthKey -NoNewline -Encoding ascii
  icacls $keyFile /inheritance:r /grant "vasudev:F" /grant "SYSTEM:F" | Out-Null
  $out = ""
  $ErrorActionPreference = "Continue"
  for ($attempt = 1; $attempt -le 6; $attempt++) {
    $out = (& $ts up --unattended=true --accept-routes --hostname=$($params.tailnetName) --auth-key="file:$keyFile" 2>&1 | Out-String)
    if ((Get-TailscaleState) -eq "Running") { break }
    Start-Sleep -Seconds 10
  }
  $ErrorActionPreference = "Stop"
  Remove-Item -Force $keyFile -ErrorAction SilentlyContinue
  if ((Get-TailscaleState) -ne "Running") { "first-boot: tailscale-failed $out"; exit 3 }
}

# 2. TightVNC service: loopback only, VncAuth, no HTTP viewer, no tray icon. The password is an MSI
#    property for this one call (TightVNC stores it DES-obfuscated in HKLM\SOFTWARE\TightVNC\Server).
if (-not (Get-Service tvnserver -ErrorAction SilentlyContinue)) {
  Install-Msi (Get-Pinned "tightvnc") @(
    "ADDLOCAL=Server", "SERVER_REGISTER_AS_SERVICE=1", "SERVER_ADD_FIREWALL_EXCEPTION=0",
    "SET_USEVNCAUTHENTICATION=1", "VALUE_OF_USEVNCAUTHENTICATION=1",
    "SET_PASSWORD=1", "VALUE_OF_PASSWORD=$($params.vncPassword)",
    "SET_LOOPBACKONLY=1", "VALUE_OF_LOOPBACKONLY=1", "SET_ALLOWLOOPBACK=1", "VALUE_OF_ALLOWLOOPBACK=1",
    "SET_ACCEPTHTTPCONNECTIONS=1", "VALUE_OF_ACCEPTHTTPCONNECTIONS=0",
    "SET_RUNCONTROLINTERFACE=1", "VALUE_OF_RUNCONTROLINTERFACE=0",
    "SET_REMOVEWALLPAPER=1", "VALUE_OF_REMOVEWALLPAPER=0", "SET_RFBPORT=1", "VALUE_OF_RFBPORT=5900")
}
# Administrators keep full control so a rerun can rewrite the file; the node reads it as vasudev.
if (Test-Path "$opt\vnc-password.txt") { icacls "$opt\vnc-password.txt" /grant "Administrators:F" | Out-Null }
Set-Content -Path "$opt\vnc-password.txt" -Value $params.vncPassword -NoNewline -Encoding ascii
icacls "$opt\vnc-password.txt" /inheritance:r /grant "vasudev:R" /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

# 3. Node 26, MinGit, pnpm via corepack.
if (-not (Test-Path "C:\Program Files\nodejs\node.exe")) { Install-Msi (Get-Pinned "node") @() }
if (-not (Test-Path "$opt\git\cmd\git.exe")) { Expand-Archive (Get-Pinned "git") -DestinationPath "$opt\git" -Force }
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
foreach ($p in "C:\Program Files\nodejs", "$opt\git\cmd", "$opt\bin", "$opt\caddy") {
  if ($machinePath -notlike "*$p*") { $machinePath = "$machinePath;$p" }
}
[Environment]::SetEnvironmentVariable("Path", $machinePath, "Machine")
$env:Path = $machinePath
& "C:\Program Files\nodejs\corepack.cmd" enable --install-directory "$opt\bin" | Out-Null

# 4. Caddy as a startup scheduled task (Caddy has no Windows service mode of its own).
if (-not (Test-Path "$opt\caddy\caddy.exe")) { Expand-Archive (Get-Pinned "caddy") -DestinationPath "$opt\caddy" -Force }
$tailnetIp = (& $ts ip -4).Trim()
# The front password goes to caddy on stdin, not as --plaintext in argv.
$bcrypt = ($params.frontPassword | & "$opt\caddy\caddy.exe" hash-password).Trim()
$caddyfile = @'
{{CADDYFILE_TMPL}}
'@
$caddyfile = $caddyfile.Replace("{{TAILNET_IP}}", $tailnetIp).Replace("{{OWNER_EMAIL}}", $params.ownerEmail).Replace("{{FRONT_PASSWORD_BCRYPT}}", $bcrypt)
Set-Content -Path "$opt\caddy\Caddyfile" -Value $caddyfile -Encoding ascii
& "$opt\caddy\caddy.exe" validate --config "$opt\caddy\Caddyfile" | Out-Null
if (-not (Get-ScheduledTask -TaskName "Vasudev Caddy" -ErrorAction SilentlyContinue)) {
  $action = New-ScheduledTaskAction -Execute "$opt\caddy\caddy.exe" -Argument "run --config $opt\caddy\Caddyfile" -WorkingDirectory "$opt\caddy"
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName "Vasudev Caddy" -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}
Start-ScheduledTask -TaskName "Vasudev Caddy"

# 5. Auto sign-in for vasudev (Sysinternals Autologon keeps the password as an LSA secret, not
#    plain text in the registry), no lock, no screen saver, foreground lock off.
if (-not (Test-Path "$opt\bin\Autologon64.exe")) { Expand-Archive (Get-Pinned "autologon") -DestinationPath "$opt\bin" -Force }
& "$opt\bin\Autologon64.exe" /accepteula vasudev $env:COMPUTERNAME $params.adminPassword | Out-Null
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
$policies = @{
  "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" = @{ NoAutoUpdate = 0; AUOptions = 2; NoAutoRebootWithLoggedOnUsers = 1 }
  "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" = @{ DisableLockWorkstation = 1 }
  "HKCU:\Control Panel\Desktop" = @{ ScreenSaveActive = "0"; ForegroundLockTimeout = 0 }
}
foreach ($path in $policies.Keys) {
  New-Item -Path $path -Force | Out-Null
  foreach ($kv in $policies[$path].GetEnumerator()) { New-ItemProperty -Path $path -Name $kv.Key -Value $kv.Value -Force | Out-Null }
}

Set-Content -Path "$opt\first-boot.done" -Value (Get-Date -Format o) -Encoding ascii
"first-boot: ok"
Restart-Computer -Force
