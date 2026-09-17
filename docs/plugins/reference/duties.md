---
summary: "Saved, replayable automations the agent authors from your instructions."
read_when:
  - You are installing, configuring, or auditing the duties plugin
title: "Duties plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Saved, replayable automations the agent authors from your instructions.

## Distribution

- Package: `@openclaw/duties`
- Install route: included in Vasudev

## Surface

- Contracts: `tools`
- Skills

<!-- openclaw-plugin-reference:manual-start -->

The Team roster (who may give the agent instructions, and the `team_list` tool) moved to the separate `team` plugin — see [its reference](/plugins/reference/team) and [its guide](/plugins/team). Duties' own `duties.settings.set { owner }` stays as a fallback owner target for when Team has no answer yet.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [duties](/plugins/duties)
