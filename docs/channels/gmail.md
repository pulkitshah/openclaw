---
summary: "Connect a Gmail inbox with an app password through the Control UI's guided Gmail card"
read_when:
  - Connecting Gmail as a Duties mail trigger from the Control UI
  - Deciding between the Gmail app-password card and the hooks.gmail Pub/Sub webhook
title: "Gmail"
---

The Channels hub's **Gmail** card is a guided setup wizard built on the bundled
[IMAP email trigger plugin](/automation/imap), not on `hooks.gmail`/Pub/Sub. It walks through
enabling 2-Step Verification, generating a 16-character Google [app password](https://myaccount.google.com/apppasswords),
and entering the addresses allowed to trigger a run — no Google Cloud project, `gcloud` auth, or
public exposure required, so it works on a headless hosted desk as well as a local install.

Gmail is not a two-way chat channel plugin: this card writes a single
`plugins.entries.imap.config.accounts.gmail` entry (host `imap.gmail.com`, the entered address and
app password, and `agentId: "duties-mail"`), the same account shape [Duties' mail-trigger
readiness readout](/plugins/duties#mail-triggers) already recognizes. Reconfiguring the card
overwrites that one account; a **Disconnect** action in its detail view removes it without touching
any other IMAP account you configured by hand.

## When to use `hooks.gmail`/Pub/Sub instead

Use the classic [Gmail Pub/Sub webhook](/automation/hooks) path only when you specifically need
Gmail-hook features this card does not provide — for example, fetching attachment content through
`gog gmail <read/download>` (the IMAP path only ever sees an attachment's filename, never its
content) or multiple hook-routed mailboxes on distinct paths. That path needs a Google Cloud
project, `gcloud` authentication, a Pub/Sub topic/subscription, and a public HTTPS endpoint
(Tailscale Funnel or equivalent) — real cloud infrastructure setup that this guided card
deliberately avoids.

## Config reference

See the [IMAP email trigger](/automation/imap) page for the full `accounts.*` schema (mailbox,
polling/IDLE mode, sender authentication, message size limits) if you want to hand-edit the
account this card wrote, or add further non-Gmail IMAP mailboxes alongside it.
