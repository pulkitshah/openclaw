#!/usr/bin/env node

import path from "node:path";
// Guard: fails when an allowlisted user-visible file still contains a
// literal "OpenClaw". This is exactly `rebrand-apply.mjs --check`; keeping
// it a separate entry point gives `check-changed`/CI a stable command name
// independent of the apply script's own CLI surface.
import { runRebrandCli } from "./rebrand-apply.mjs";

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  process.exitCode = runRebrandCli(["--check", ...process.argv.slice(2)]);
}
