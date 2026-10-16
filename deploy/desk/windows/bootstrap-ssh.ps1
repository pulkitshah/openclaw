# Runs once through `az vm run-command invoke` as SYSTEM: turns on the OpenSSH Server feature,
# trusts the operator's public key for the vasudev administrator, and opens port 22 in the
# Windows firewall. Carries no secrets: the key is public, the password never passes through
# here. Everything after this step happens over SSH. The SSH shell stays cmd.exe on purpose:
# with PowerShell as the login shell, PowerShell's own host reads the session's stdin and the
# scripts this recipe pipes over SSH never see it (observed live 2026-10-16: a staged script hung
# forever on [Console]::In.ReadToEnd()). Every remote call invokes powershell.exe explicitly.
param([Parameter(Mandatory = $true)][string]$PublicKey)
$ErrorActionPreference = "Stop"

$cap = Get-WindowsCapability -Online | Where-Object Name -like "OpenSSH.Server*"
if ($cap.State -ne "Installed") { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

# Administrators authenticate against this one file, not their own ~/.ssh; sshd refuses it unless
# only SYSTEM and Administrators can read it.
$authKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
Set-Content -Path $authKeys -Value $PublicKey -Encoding ascii
icacls $authKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

# A DefaultShell left behind by an older recipe would bring the stdin problem back.
Remove-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -ErrorAction SilentlyContinue

# Password auth off: the NSG limits who can reach port 22, the key limits who gets in.
$cfg = "C:\ProgramData\ssh\sshd_config"
$lines = Get-Content $cfg | Where-Object { $_ -notmatch "^\s*#?\s*PasswordAuthentication" }
$lines += "PasswordAuthentication no"
Set-Content -Path $cfg -Value $lines -Encoding ascii
Restart-Service sshd

if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
    -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
"bootstrap-ssh: ok"
