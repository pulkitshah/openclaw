# Azure Windows desk (TripIn Studio) — design

Build TripIn Studio's desk on a fresh Azure virtual machine running Windows Server, with the
Gateway and the desktop node on the same box, so the studio no longer depends on the office PC and
the same recipe becomes the Windows client deployment. Approved in conversation 2026-10-16.

## 1. Goal

- One Windows VM carries the complete desk: the Vasudev Gateway, the desktop node that fulfils
  `computer.act` and `screen.snapshot`, a loopback VNC server for the portal's Desktop view, and
  the client's Windows applications (Tally first; Travelport Galileo possible later).
- Everything about the box is reproducible from the repository plus a per-desk env file on the
  operator's Mac: creating the VM, first boot, joining the tailnet, installing the fork, writing
  the desk config, pairing the node, health checks. A second client is the same scripts with a
  different env file.
- Traffic to a named list of whitelisted destinations leaves through the operator's Mac so those
  services see the allowed IP; everything else uses Azure's own internet. The list can grow
  (Galileo) without touching the VM.
- The office PC desk (`tripin-studio`, WSL2) and its Windows node are retired after the Azure desk
  passes the test plan.

## 2. Decisions (from the design conversation, 2026-10-14 → 2026-10-16)

| Decision                               | Choice                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloud                                  | **Azure**, subscription "Azure subscription 1" (free account created 2026-10-15, to be upgraded to pay-as-you-go)                                                                                                                                                                                      | Cheapest Windows VM with an India region; DigitalOcean has no Windows, Oracle bills Windows at $0.092/OCPU-h ($94/mo for 1 OCPU), AWS t3a.large is $56.                                                                                                      |
| Region                                 | **Central India** (Pune) at $43/mo for the size below; **South India** ($84/mo) only if Central India stays restricted after the upgrade                                                                                                                                                               | Trial subscriptions are blocked from all B/D sizes in Central India; South India is open but priced ~2×.                                                                                                                                                     |
| Size                                   | `Standard_B2as_v2` (2 vCPU AMD, 8 GB, burstable), 128 GB Premium SSD; next size up (`B4as_v2`) is the same recipe with one variable                                                                                                                                                                    | Desk work is bursty; 8 GB fits Gateway + Chromium + Tally.                                                                                                                                                                                                   |
| Image                                  | Windows Server 2022 Datacenter **Azure Edition**, Gen2, licence included                                                                                                                                                                                                                               | Server licence is in the hourly price; Windows 11 on Azure needs an eligible Microsoft 365/E3 licence.                                                                                                                                                       |
| One box, not Linux desk + Windows node | Native Windows Gateway (the fork's managed scheduled task) **and** the node on the same VM                                                                                                                                                                                                             | Owner wants one server per client; WSL2 needs nested virtualisation, which B-series VMs do not have.                                                                                                                                                         |
| Front door                             | Unchanged: `vasudev.tripinstudio.com` → Caddy on the VM's tailnet address `:8443` (basic auth, `X-Forwarded-User`) → Gateway on loopback in trusted-proxy mode                                                                                                                                         | Proven pattern on the office PC and Prabhat; the front-door droplet is already on the tailnet.                                                                                                                                                               |
| Node → Gateway path                    | Primary: the Gateway's managed Tailscale ingress (`wss://<vm>.tail325f09.ts.net`) from the same box; fallback: the office-PC loopback entrance (Caddy on `127.0.0.1:18790` injecting the identity, `allowLoopback: true`)                                                                              | Native Tailscale on the VM makes the ts.net URL reachable, which it was not from Windows when Tailscale lived in WSL. The fallback is proven and, on a VM nobody else logs into, bounded.                                                                    |
| Portal screen view                     | **TightVNC** server as a Windows service, loopback only, VncAuth, HTTP viewer off; Gateway allows `desktop.stream`                                                                                                                                                                                     | The fork relays an existing loopback RFB server; it never captures itself.                                                                                                                                                                                   |
| Console                                | Auto sign-in for the service account at boot, screen saver/lock off, **no RDP while Vasudev works**                                                                                                                                                                                                    | Computer use and the screen view live on the interactive console; an RDP session takes it over.                                                                                                                                                              |
| Egress for whitelisted destinations    | A paired desktop node chosen **in the portal** advertises the desk's whitelist as /32 Tailscale routes; the desk accepts routes. Not an exit node. For this build the Mac is that node; until the portal feature ships (section 9) the same routes are set on the Mac by hand as a documented stopgap. | Owner 2026-10-16: "I should be able to connect any system from Vasudev itself for IP whitelist routing"; a node app plus Tailscale defines "any system". Only whitelisted traffic depends on that machine being awake (see memory `desk-egress-via-laptop`). |
| Build                                  | `dist/` built on the Mac at the pinned commit and pushed to the VM; `pnpm install` runs on the VM for native platform packages                                                                                                                                                                         | A 2-vCPU VM should not run the tsdown build (needs ~4.3 GB heap, took hours with retries on the office PC). `dist/` is one unit (see office-pc runbook §10).                                                                                                 |
| Windows Update                         | Notify-only with a weekly maintenance window chosen by the owner                                                                                                                                                                                                                                       | The office PC rebooted mid-day on 2026-10-14 from an unattended update and the node stayed down until someone signed in.                                                                                                                                     |
| Administration                         | WinRM over HTTPS bound to the Tailscale interface, from the Mac; no public inbound ports at all (NSG default-deny, no RDP)                                                                                                                                                                             | Tailscale SSH is not available on Windows; Tailscale provides the only path in.                                                                                                                                                                              |
| Secrets                                | Per-desk env file on the Mac (`~/cashew-secrets/<desk>.env`), piped over WinRM into files with restricted ACLs; never in chat, git, or Azure custom-data                                                                                                                                               | Same rule as every other desk.                                                                                                                                                                                                                               |

## 3. Topology

```
owner's browser ── https://vasudev.tripinstudio.com ── front door (139.59.72.76 / 100.64.91.103)
                                                             │ tailnet, basic auth, X-Forwarded-User
                                                             ▼
                               Azure VM  vasudev-tripin-az  (tailnet: tripin-az)
                               ┌──────────────────────────────────────────────┐
                               │ Caddy  <tailnet-ip>:8443 ──► Gateway 127.0.0.1:18789
                               │ Gateway (scheduled task, user `vasudev`)    │
                               │ Node host (scheduled task at logon)  ──► Gateway via ts.net ingress
                               │ cua-computer driver (in-process, interactive console)
                               │ TightVNC service 127.0.0.1:5900  ◄── node desktop.stream relay
                               │ Tally (console session, auto signed-in)    │
                               └──────────────────────────────────────────────┘
                                          │ /32 routes for whitelisted addresses
                                          ▼
                               operator's Mac (subnet router + browser node) ──► whitelisted services
```

Azure resources, all in resource group `vasudev` (Central India): VNet `vasudev` 10.30.0.0/16,
subnet `desks` 10.30.1.0/24, NSG `vasudev-desks` (no inbound rules; outbound allowed), one
public IP (needed only for Tailscale's outbound NAT traversal and Windows activation; nothing
listens on it), the VM, its OS disk. Naming: `vasudev-<client>-az`.

## 4. Provisioning recipe

Committed under `deploy/desk/`:

1. **`new-desk-azure.sh <desk-name> <env-file>`** (Mac, needs `az login` and `tailscale` on the
   same tailnet): creates the resource group, network, NSG and VM with
   `az vm create --image MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition:latest
--size Standard_B2as_v2 --admin-username vasudev --admin-password <from env file>
--nsg-rule NONE --public-ip-sku Standard`, then attaches the Custom Script Extension
   running `windows-first-boot.ps1` with the Tailscale pre-auth key and the fork commit as
   protected settings. Waits for the VM to appear on the tailnet (reuses `lib/desk-ops.sh` waits
   where they apply), then runs step 3.
2. **`windows-first-boot.ps1`** (runs once as SYSTEM on the VM): installs Tailscale (MSI, joins
   with the pre-auth key, `--accept-routes`, hostname from the env), enables WinRM over HTTPS on
   the Tailscale interface only, installs Node 26 + corepack/pnpm + git via winget or MSI,
   TightVNC (MSI, `ADDLOCAL=Server`, `SET_LOOPBACKONLY=1`, `SET_ALLOWLOOPBACK=1`,
   `SET_ACCEPTHTTPCONNECTIONS=0`, `SET_USEVNCAUTHENTICATION=1`, password from the env), Caddy
   (zip → `C:\opt\caddy`, scheduled task at startup), creates `C:\opt`, sets auto sign-in
   (`HKLM\...\Winlogon` AutoAdminLogon with the account password stored by `Autologon` /
   LSA secret, not plain text), disables screen saver and lock, sets Windows Update to notify
   only, and reboots into the signed-in console.
3. **`provision-windows.ps1`** (pushed and run over WinRM from the Mac after the reboot, as the
   `vasudev` user): clones the fork into `C:\opt\openclaw` at the pinned commit,
   `pnpm install --frozen-lockfile --ignore-scripts` (native platform packages: cua-driver
   win32-x64), receives `dist/` from the Mac (`tar` over WinRM; the Mac builds it with the same
   commands as `roll.sh` at the same commit), writes `%USERPROFILE%\.openclaw\openclaw.json` from
   `openclaw.client.json.tmpl` converted to the trusted-proxy shape (`gateway.auth`,
   `gateway.trustedProxies`, `controlUi.allowedOrigins`, `gateway.nodes.commands.allow:
["desktop.stream"]`, `desktop.host` for the node), writes the secrets files, registers the
   Gateway with `openclaw gateway install`, registers the node's logon task
   (`node run --display-name "<Client> desktop"` against the ts.net URL; `--pair` on first run),
   approves the pairing and the `desktop.stream` surface from the desk CLI, and runs
   `desk-health.ps1`.
4. **`desk-health.ps1`**: Gateway task running, `/healthz`, node connected with `computer.act`
   - `screen.snapshot` + `desktop.stream`, TightVNC listening on `127.0.0.1:5900` only, console
     session signed in and unlocked, Tailscale online with routes accepted, egress check (a request
     to one whitelisted address reports the Mac's public IP; a request elsewhere reports Azure's).
5. **Front door**: `users.json` entry (already exists for the owner), Caddy route `@tripin`
   repointed from `100.95.17.69:8443` to the VM's tailnet address.
6. **Egress device**: through the portal feature in section 9 once it exists; until then
   `tailscale set --advertise-routes=<a.b.c.d/32,...>` on the Mac from the whitelisted list kept
   in the env file, with the owner approving the routes once in the Tailscale admin console. The
   stopgap is recorded in the runbook and removed when section 9 lands.
7. **`windows-desk-runbook.md`**: every step as executed, with the as-built block (names,
   addresses, dates) the way `office-pc-runbook.md` records the office PC.

## 5. Desktop behaviour

- The `vasudev` local administrator is the only account; it is auto signed in at boot and never
  locked. Operators administer through WinRM or through the portal's Desktop view, never RDP
  while a run is active.
- The cua-computer driver runs in-process in the node host on the interactive console, so the
  Windows fixes from 2026-10-14 (one execution per run, Win key as Ctrl+Esc, foreground raise
  with background fallback, unverifiable shell clicks) apply unchanged. `ForegroundLockTimeout`
  is set to 0 for the account at provisioning, so foreground delivery works without the fallback.
- TightVNC runs as a service, so the screen is viewable from the portal at the sign-in screen
  and after a crash of the node host, not only while the node is up.
- Windows Update: notify only; the owner picks a weekly window; updates are applied by an
  operator who then reruns `desk-health.ps1`.

## 6. Test plan (acceptance)

1. Front-door login as the owner lands in the new desk's chat; the old desk is unreachable from
   the front door.
2. Devices page shows "<Client> desktop" connected with `computer.act`, `screen.snapshot`,
   `desktop.stream`; "Open desktop" shows the live console.
3. Coordinator: screenshot, open Tally, navigate to a known report by keyboard, read a value;
   each action visible on the portal view.
4. Egress: from the VM, `curl ifconfig.me`-style checks against one whitelisted address show the
   Mac's public IP, against another host show Azure's; with the Mac asleep, only the whitelisted
   address fails.
5. Reboot test: `az vm restart`; within 5 minutes the console is signed in, Gateway, node, Caddy,
   TightVNC are up, and `desk-health.ps1` is green without a hand on the box.
6. Second-desk test (later, first client): the same scripts with a new env file produce a working
   desk; any manual step found is folded back into the scripts.

## 7. Cutover and retirement

1. Owner provides the Tally installer and licence; Tally is installed after step 6.2 passes.
2. Front door route moved; the owner signs in and confirms.
3. Office PC: Gateway and node tasks disabled, WSL desk left in place for one week, then the
   distro and `C:\opt` are removed; the tailnet node `tripin-studio` is deleted.
4. Memory and runbooks updated; `tripin-studio-desk` memory marked retired.
5. Free-credit deadline ~2026-11-14: the subscription must be pay-as-you-go by then (expected
   already, as the size restriction requires it).

## 8. Risks and open items

| Item                                             | Status                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Central India size restriction after the upgrade | Re-check after the subscription shows pay-as-you-go; if still blocked, file the quota request or build in South India at $84/mo. |
| Node pairing over the same-box ts.net ingress    | Unproven; fallback is the loopback entrance, proven on the office PC.                                                            |
| TightVNC + driver on a server image              | Both are standard Win32; the server SKU has no known difference, verified by step 6.2/6.3.                                       |
| Burstable CPU                                    | Monitor credits in the first week; move to `B4as_v2` if Tally + Chromium exhaust them.                                           |
| Whitelisted address list                         | Owner to provide; Galileo's addresses added when known.                                                                          |
| Egress-device feature (section 9)                | Separate spec/plan; the desk ships with the manual Mac stopgap and the feature replaces it before the first client.              |
| Tally licensing on a cloud VM                    | Owner's call; the recipe does not depend on it.                                                                                  |
| Windows activation on Azure                      | Azure Edition images activate against Azure KMS over the public IP; keep outbound 1688/TCP open (NSG default allows outbound).   |

## 9. Egress device, managed from Vasudev (separate spec and plan)

Owner requirement (2026-10-16): the machine that carries whitelisted traffic is chosen and
connected from Vasudev itself, for any machine running the Vasudev node app plus Tailscale, not
by an operator editing Tailscale on that machine. This is its own subsystem; it gets its own spec
and implementation plan after this desk exists, and it must land before the first client desk.
The outline agreed so far, so this spec and that one fit:

- **Where it lives**: a bundled plugin (name chosen in its spec) that owns the desk's whitelist,
  the chosen device, the node command, and a Control UI panel through the plugin UI contract. No
  new core tool; the model never touches it.
- **Portal**: Devices page gains "Route whitelisted traffic through this device" on each paired
  desktop node, plus a whitelist editor (hostnames resolved to addresses, or addresses) in
  Settings. One device at a time per desk; switching moves the routes.
- **Node side**: a node command (for example `egress.routes.set`) that runs the local
  `tailscale set --advertise-routes=...` with an allowlisted argument shape and reports the
  result. Declared by desktop nodes only; gated like other dangerous commands by
  `gateway.nodes.commands.allow`.
- **Gateway side**: approves the advertised routes through the Tailscale API with an API access
  token or OAuth client (`devices:routes` scope) stored as a desk secret; the desk itself runs
  with `--accept-routes`. Removing or switching the device withdraws the routes.
- **Platform notes to verify in that spec**: macOS Tailscale app support for `--advertise-routes`
  in the installed variant; Windows and Linux need IP forwarding enabled by the node app's
  installer; the chosen device's own internet becomes the path only for the whitelisted
  addresses, so an offline device degrades, never blacks out, the desk.
- **Proof**: the Mac is the first egress device for the TripIn Studio desk; the test in section
  6.4 is rerun through the portal path, and the manual stopgap from section 4.6 is removed.
