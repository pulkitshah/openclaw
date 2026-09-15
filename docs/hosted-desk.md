---
summary: "An always-on cloud machine that runs your Gateway and Duties with a real, headed browser, kept tailnet-only apart from one Gmail webhook route"
read_when:
  - You want Duties to keep running while your laptop is closed
  - You're deciding whether a hosted desk is worth the monthly cost
  - You need the prerequisites or the command shape for creating one
  - You're setting up a desk for someone else and want them to onboard it themselves
title: "Hosted desk"
---

A **hosted desk** is an always-on Linux machine in the cloud that runs your Vasudev Gateway with a real, headed browser attached. Duties that click through a real site keep running on their own schedule, on mail, or on demand — even while your laptop is closed. The Control UI and SSH are reachable only over your own [Tailscale](/gateway/tailscale) network; a desk configured for Gmail push also exposes one webhook route to the public internet (see [Gmail push per desk](#gmail-push-per-desk) below).

One desk runs one Gateway. It is the same Vasudev you already use, just running on a machine that never sleeps.

## What it costs

A desk is a single DigitalOcean droplet:

| Size          | Good for                           | Price       |
| ------------- | ---------------------------------- | ----------- |
| `s-2vcpu-4gb` | One or two Duties running at once  | ≈ $24/month |
| `s-4vcpu-8gb` | Several Duties running in parallel | ≈ $48/month |

These are DigitalOcean's list prices in the region this setup uses, billed by DigitalOcean directly, and can change. Nothing else about a desk carries a recurring fee.

## Before you create one

You'll need, gathered ahead of time:

- A DigitalOcean account, with `doctl` signed in on the machine you'll run the create command from.
- A Tailscale account and an auth key for the tailnet the desk should join. Generate it as **single-use (ephemeral) and tagged**: DigitalOcean keeps the droplet's user-data — which carries that key — readable from the machine itself for the droplet's whole life, so a single-use key is already spent by the time anyone could read it. If you use a reusable key, rotate it once the desk is up.
- A Telegram bot token for the desk's own agent (each desk uses its own bot).
- A Telegram user or chat id you want that bot to answer to.

The last two are for a desk you run yourself. A [client desk](#client-desk) needs neither — the
person you hand it to adds Telegram themselves.

Put the Tailscale auth key and the Telegram bot token in two separate files — for example under `~/.openclaw-desk-secrets/`, each `chmod 600` — and pass their paths to the create command below. Never paste either value into chat or into a config file directly.

## Create one

```sh
deploy/desk/new-desk.sh <desk-name> \
  --ts-authkey-file <path-to-the-tailscale-authkey-file> \
  --tg-token-file <path-to-the-telegram-bot-token-file> \
  --owner-target <telegram-user-or-chat-id>
```

Creating a desk for someone else? See [Client desk](#client-desk) below — `--profile client`
drops the two Telegram flags and leaves the desk to be set up by whoever receives it.

This boots a `s-2vcpu-4gb` droplet by default (pass `--size s-4vcpu-8gb` for more parallel runs) and prints the desk's Control UI address plus the command to reveal the first sign-in token. Creating a desk usually takes 15–25 minutes. The command first waits for the desk to appear on your tailnet, then keeps waiting until the Gateway answers at its tailnet URL, and prints that URL only when it does. If the desk does not answer within 30 minutes, the command stops with the log command to run. Full flag and environment-override reference: `deploy/desk/README.md`.

## Client desk

A desk you hand to someone else should start where a fresh install starts, not inside your setup.
Create it with `--profile client`:

```sh
deploy/desk/new-desk.sh <desk-name> --profile client \
  --ts-authkey-file <path-to-the-tailscale-authkey-file>
```

No Telegram bot token and no owner target: a client desk configures no channel, no agents and no
mail hooks — only the desk plumbing (the Gateway, its tailnet-only Control UI and token auth, the
browser, and the bundled plugins, enabled but unconfigured). Everything else — the image, the
headed Chromium, the health check, rolling and snapshots — is identical to your own desk.

### What the client sees first

You still do the [first sign-in](#first-sign-in) steps and hand over the Control UI address and
token. From there the client gets the same onboarding as any new Vasudev install:

1. **Model Setup** — they connect Claude by signing in with their own account.
2. **Name the assistant** — the first conversation runs the [bootstrap ritual](/start/bootstrapping),
   which asks what to call the assistant. Nothing arrives pre-named.
3. **Add Telegram** — from **Settings → Telegram**, by pasting a bot token they create with
   BotFather. The Telegram plugin is already installed and enabled; the token is the only input.

**Gmail connect is a coming feature** on a client desk. Mail triggers need per-desk Google Cloud
setup that runs from a machine with `gcloud`, so a client desk ships with no hooks and no public
webhook route at all — not a half-configured one. Everything a client desk exposes stays
tailnet-only.

## First sign-in

Three one-time steps make a fresh desk fully usable, in order:

1. **Sign in to the Control UI** at the printed URL with the token the create command printed. The
   command it printed needs both a terminal and the service user's own home, so run it exactly as
   printed:
   ```sh
   ssh -t root@<desk-name> 'sudo -H -u openclaw node /opt/openclaw/openclaw.mjs gateway auth-token --show'
   ```
2. **Approve the device pairing request** — a first-time browser tab or CLI client registers a
   pending pairing request that the Gateway refuses to serve until you explicitly approve it
   (`openclaw devices approve <request-id>`); the sign-in token alone is not enough.
3. **Sign Claude in** — the desk's agents run on your own Claude subscription, not an API key,
   so nothing replies until `claude auth login` is run as the desk's service user. Model routing is
   already set up on a desk (every `anthropic/*` model points at the Claude CLI runtime), so this
   one login is all it takes.

See `deploy/desk/README.md`'s "First sign-in" and "Sign Claude in" sections for the exact
commands.

## What runs on it

Once first boot finishes, a desk runs:

- The **Gateway** itself, as a system service that restarts on its own and comes back after a reboot.
- A **virtual display and a headed Chromium** — the same browser a Duty would use on your own machine, just running on a screen nobody has to look at.
- A **health check** every couple of minutes, which the Duties page's Desk card reads.
- **Tailscale**, joined to your tailnet, serving the Control UI at a tailnet-only address.

## How to reach it

- **Control UI** — `https://<desk-name>.<tailnet>.ts.net`, open to any device on your tailnet and never to the public internet ([Tailscale Serve](/gateway/tailscale)).
- **SSH** — over the tailnet, using the desk name as the host.
- **The Telegram bot** — the one you supplied a token for, answering only the owner target you set.
  A [client desk](#client-desk) has no bot until its owner adds one from Settings.

The only thing a desk ever exposes to the public internet is a single webhook path on a second
port, `<desk-name>.<tailnet>.ts.net:8443/gmail-pubsub`, present from first boot so Gmail push
setup ([below](#gmail-push-per-desk)) needs no extra exposure step. The Control UI, SSH, and
everything else stay tailnet-only.

## Store logins

Open the desk's Control UI [Logins page](/plugins/duties#logins) and add whatever a Duty needs to sign in somewhere. On a desk, those values are kept encrypted on the desk itself and are never sent through the agent's context.

## Gmail push per desk

A desk that should react to inbound mail needs the same [mail-trigger setup](/plugins/duties#setup) as any other Gateway. Gmail push needs one public URL for Google's Pub/Sub delivery; a desk exposes only that one webhook path (`:8443/gmail-pubsub`), through a persistent background Tailscale Funnel set up by cloud-init at first boot — never on the Control UI's own port 443, which the Gateway keeps tailnet-only via Serve. Because that setup needs `gcloud`, which a desk does not have, the mail-trigger CLI setup command runs on a machine that has it instead of on the desk; see `deploy/desk/README.md`'s "Gmail push per desk" section for the exact steps and the config fields to carry over.

## Security notes

- **Network**: no public ports except the one Gmail webhook path noted above; everything else
  (Control UI, SSH) is reachable only over your tailnet, gated by both tailnet identity and the
  Gateway's own token.
- **The cloud metadata service is blocked for non-root processes**: DigitalOcean keeps a droplet's
  user-data — the setup document that carried this desk's Tailscale auth key, Telegram bot token,
  Gateway token and webhook token — readable for the droplet's whole life from an unauthenticated
  link-local address, to any process on the machine. That matters here because a desk deliberately
  hands untrusted inbound mail to an agent. Every desk therefore boots a small service that rejects
  traffic to that address from every non-root account, so the service user the Gateway, Duties and
  the browser run as cannot read it; only root can. It is switched on as the very last step of first
  boot, because setup itself needs the metadata service. This is defence in depth, not a substitute
  for the single-use Tailscale key above.
- **Chromium's sandbox, restored, not removed**: Ubuntu 24.04 ships with unprivileged user
  namespaces restricted under AppArmor by default, which blocks Chromium's own sandbox setup
  (it fails to start at all, with "No usable sandbox!"). A desk relaxes exactly that one kernel
  restriction (`kernel.apparmor_restrict_unprivileged_userns`) via a `sysctl.d` file, so Chromium
  can build its sandbox the way it does on any desktop Linux without that restriction — this is
  narrower than running Chromium with `--no-sandbox`, which disables its sandbox for every
  renderer process rather than restoring it, and is not a general AppArmor policy change for
  other confined binaries on the box.

## Parallel runs

The Duties settings page's **Desk** card carries a parallel-runs setting alongside the desk's health chips. Raise it and more Duty runs execute at once, each in its own browser tab; lower it and extra runs wait their turn in the queue instead of failing. A `s-2vcpu-4gb` desk comfortably handles a couple of runs at once; a `s-4vcpu-8gb` desk handles several more.

The card also says how old its health reading is, and greys the chips out when that reading stops being refreshed — so a desk whose health check has stopped looks stopped, rather than permanently healthy.

## Updating, snapshots, and tearing down

- **Update** a desk in place by rolling it to a newer version — `deploy/desk/README.md`'s Roll section covers the command and how it avoids interrupting a live run.
- **Snapshot** a desk so you can recreate it quickly later — see that runbook's Snapshot / restore section.
- **Tear down** a desk you no longer need — see its Tear down section, which also covers revoking the desk's Telegram bot token.

For the full command reference, health-check meaning, log locations, and troubleshooting, see `deploy/desk/README.md`.

## Limits for now

- Linux only, browser Duties only — a desk can't drive a desktop app; there's no desktop or whole-screen control yet.
- No fleet or control-plane view — each desk is created and rolled by hand with the scripts above.
- No shared or multi-tenant desks.
- No autoscaling.
- No automatic backups beyond the snapshots you take yourself.
