# Azure Windows desk runbook

Plan: `docs/superpowers/plans/2026-10-16-azure-windows-desk.md`. Spec:
`docs/superpowers/specs/2026-10-16-azure-windows-desk-design.md` (git-ignored directory; both files are
force-added, so `git show HEAD:<path>` prints them). The scripts live in `deploy/desk/new-desk-azure.sh`
and `deploy/desk/windows/`; the README section "Azure Windows desk" is the short form.

## Status

Not yet executed. Filled in by the live run: dates, VM name, tailnet name and address, fork commit,
and every deviation from the plan.

## 1. Azure account and CLI

- Free account → the pay-as-you-go upgrade is required before the cheap B/D sizes are allowed in the
  restricted regions. On 2026-10-16 (after the upgrade) Central India still reported
  `NotAvailableForSubscription` for every B/D size; Jio India West and Jio India Central were open at
  the same $43/month for B2as v2 ($84 in South India, $77 in West India). The create script defaults
  to `centralindia`; pass `--location jioindiawest` until Central India opens. Check with
  `az vm list-skus -l <region> --size Standard_B2as_v2 --resource-type virtualMachines --query "[0].restrictions"`.
- `az login --tenant <tenant id>`: device-code login (`--use-device-code`) is blocked by the tenant's
  security defaults (`AADSTS530035`); the browser flow works.
- Providers `Microsoft.Compute`, `Microsoft.Network`, `Microsoft.Storage` must be registered once per
  subscription (`az provider register -n <name> --wait`).

## 2. Env file

`~/cashew-secrets/<desk>.env`, mode 0600, one `KEY=value` per line, never committed, never pasted:

| Key                      | Used for                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `OWNER_EMAIL`            | front-door login, Caddy basic-auth user, `gateway.auth.trustedProxy.allowUsers`, `identityScopes`     |
| `TS_AUTHKEY`             | Tailscale pre-auth key (reusable off, 90 days); consumed once on first boot                           |
| `DESK_ADMIN_PASSWORD`    | the VM's `vasudev` administrator (Azure: 12+ characters, three classes); also the auto sign-in secret |
| `GATEWAY_ADMIN_PASSWORD` | `C:\opt\secrets\gateway-admin-password`, the trusted-proxy desk's local CLI fallback                  |
| `DESK_FRONT_PASSWORD`    | Caddy basic auth on `<tailnet-ip>:8443`; the front door's route carries it base64-encoded             |
| `VNC_PASSWORD`           | TightVNC VncAuth (6-8 characters); `C:\opt\vnc-password.txt` for the node's desktop stream            |
| `WHITELIST_ADDRESSES`    | comma-separated addresses to route through the egress device (may be empty)                           |

Generate: `openssl rand -base64 24` for passwords, `openssl rand -base64 6 | cut -c1-8` for the VNC one.

Where the secrets go: the create script never puts a value in argv on the Mac (the env file is read
on stdin by `jq`; `az vm create` takes the admin password from a 0600 file) and sends each phase's
values to the VM as one JSON document on SSH stdin. On the VM, Tailscale reads the key from a
temporary file (`--auth-key=file:`), and four tools take a secret as an argument because they
offer nothing else: msiexec (`VALUE_OF_PASSWORD` for TightVNC, once at install), Sysinternals
Autologon, `caddy hash-password --plaintext` (its prompt reads the console only on Windows), and
the desk CLI's `--password` for the approvals and the health check. The script redacts every secret value from the output it echoes.

## 3. Create

```bash
deploy/desk/new-desk-azure.sh vasudev-<client>-az --env-file ~/cashew-secrets/<client>-az.env --client <client> --location jioindiawest
```

Phases, each announced on stderr: resource group / VNet / NSG (no inbound rules) → temporary
`operator-ssh-temp` rule for this machine's public IP → `az vm create` → `bootstrap-ssh.ps1` through
`az vm run-command` (OpenSSH Server, the operator's key; the SSH shell stays cmd.exe because PowerShell as
the login shell swallows piped stdin, so every remote call invokes powershell.exe explicitly) → SSH wait →
`first-boot.ps1` over SSH (secrets on stdin; the VM reboots) → the operator rule is deleted → tailnet
wait → `push-build.sh` → `provision-desk.ps1` → `pair-node.ps1` → banner. Exit codes: 2 usage/env
file, 3 Tailscale join failed (the operator rule stays open; fix `TS_AUTHKEY` and `--resume`), 7 the
Gateway's ts.net ingress does not answer from the VM (section 5), 1 anything else (rerun with
`--resume`; the VM is never deleted). `--stop-after create|first-boot` for rehearsals.

## 4. Front door route

On `vasudev-front-door` (root, over the tailnet), in `/etc/caddy/Caddyfile` above the 403 fallthrough:

```
@<client> header X-Forwarded-User <owner email>
reverse_proxy @<client> http://<desk tailnet IP>:8443 {
	header_up Host <desk tailnet IP>:8443
	header_up X-Forwarded-User {header.X-Forwarded-User}
	header_up Authorization "Basic <base64 of owner-email:DESK_FRONT_PASSWORD>"
}
```

`users.json` needs the owner's login (bcrypt cost 14; keep the file `openclaw:openclaw 0600`). Then
`caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`. Never route to the desk's
ts.net name: that is the Gateway's managed-Tailscale ingress and rejects a chained proxy.

## 5. Loopback entrance fallback

If `pair-node.ps1` exits 7, the Gateway's `https://<tailnet-host>` ingress does not answer from the
VM itself. Fallback (the office-PC shape, `office-pc-runbook.md` §10.3-10.4): add a second listener to
`C:\opt\caddy\Caddyfile`

```
http://127.0.0.1:18790 {
	reverse_proxy 127.0.0.1:18789 {
		header_up X-Forwarded-User <owner email>
		header_up X-Forwarded-For <desk tailnet IP>
	}
}
```

restart the "Vasudev Caddy" task (`Stop-ScheduledTask`/`Start-ScheduledTask -TaskName "Vasudev Caddy"`),
mint a join code (`node C:\opt\openclaw\dist\index.js devices join-code --json --password <admin>`),
fetch `http://127.0.0.1:18790/j/<code>`, base64url it, and run
`node C:\opt\openclaw\dist\index.js node run --pair <payload> --host 127.0.0.1 --port 18790 --no-tls`
followed by `node install --host 127.0.0.1 --port 18790 --no-tls --display-name "<client> desktop"`,
then the two approvals (`devices approve`, `nodes approve`). Tradeoff: any process on the VM reaches
the desk as the owner; on a VM only the operator signs into, bounded.

## 6. Egress routes (stopgap until the portal feature, spec §9)

On the Mac: `sudo sysctl -w net.inet.ip.forwarding=1` and
`/Applications/Tailscale.app/Contents/MacOS/Tailscale set --advertise-routes=<a>/32,<b>/32` for every
`WHITELIST_ADDRESSES` entry; approve in the admin console (Machines → the Mac → Edit route settings).
The VM accepted routes at join (`--accept-routes`). Verify on the VM with
`Test-NetConnection <a> -TraceRoute`: the first hop is the Tailscale interface (100.x). Remove this
stopgap when the portal-managed egress device lands.

## 7. Acceptance

`desk-health.ps1` (over SSH: `powershell -File C:\opt\openclaw\deploy\desk\windows\desk-health.ps1
-WhitelistAddresses a,b`) prints one JSON line and exits 0 when gateway, node (with `computer.act`,
`screen.snapshot`, `desktop.stream`), vnc (loopback only), console (signed in, not locked), tailscale
and caddy are all true. The six acceptance checks from the spec §6 and their evidence are recorded
here by the live run.

## 8. Rolling, restarting, stopping

- Roll: `git checkout <sha>` on the Mac and push it to the fork (the VM fetches by sha),
  `deploy/desk/windows/push-build.sh <tailnet-host>` (builds when needed, verifies an ordinal-sorted
  sha256 manifest on the VM), then over SSH `node C:\opt\openclaw\dist\index.js gateway restart`
  and restart the node task (`Stop-ScheduledTask`/`Start-ScheduledTask -TaskName "OpenClaw Node"`;
  if `node.exe` survives, stop it by process id as `office-pc-runbook.md` §10.7 describes). When
  `pnpm-lock.yaml` changed, run the create script with `--resume` instead: it skips first boot
  (the desk already answers SSH over the tailnet) and reruns `provision-desk.ps1`, which refreshes
  the checkout and `node_modules`.
- Stop/start the VM: `az vm deallocate` / `az vm start --resource-group vasudev --name <vm>`; auto
  sign-in brings the console, Gateway, node, Caddy and TightVNC back without a hand on the box.
- Windows Update is notify-only (`AUOptions=2`); apply updates in the agreed weekly window, then rerun
  `desk-health.ps1`.

## 9. Retiring the office PC desk

Filled in when the Azure desk passes acceptance: disable the "OpenClaw Node" task and the WSL
Gateway (announce first), leave the distro for a week, then remove `C:\opt` and the probe files
listed in the plan's Task 12, and delete the `tripin-studio` tailnet node.
