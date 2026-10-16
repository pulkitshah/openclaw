# Runs once through `az vm run-command invoke` as SYSTEM: turns on the OpenSSH Server feature,
# trusts the operator's public key for the vasudev administrator, makes PowerShell the SSH shell,
# and opens port 22 in the Windows firewall. Carries no secrets: the key is public, the password
# never passes through here. Everything after this step happens over SSH.
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

New-Item -Path "HKLM:\SOFTWARE\OpenSSH" -Force | Out-Null
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell `
  -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null

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
