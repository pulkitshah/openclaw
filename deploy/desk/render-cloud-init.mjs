#!/usr/bin/env node
/**
 * Renders `cloud-init.yaml.tmpl` into a droplet-ready `#cloud-config` for one desk.
 *
 * Usage:
 *   node deploy/desk/render-cloud-init.mjs \
 *     --name <desk> --ts-authkey-file <f> --tg-token-file <f> \
 *     --owner-target <id> --git-ref <ref> [--gateway-token-file <f>] \
 *     > /tmp/<desk>.cloud-init.yaml
 *
 * Reads three secret inputs from files (never from argv, so they never land in shell history or
 * `ps`): the Tailscale auth key, the Telegram bot token, and — optionally — a pre-chosen Gateway
 * auth token. When `--gateway-token-file` is omitted a random one is generated here.
 *
 * Substitutes every `{{PLACEHOLDER}}` in `cloud-init.yaml.tmpl` (including the config file it
 * embeds from `openclaw.json.tmpl`) and refuses to print anything if an ALL_CAPS `{{PLACEHOLDER}}`
 * or an unresolved `{{INCLUDE:…}}` survives — see docs/superpowers/specs/2026-09-14-hosted-desk-
 * design.md §10 ("Secrets never in cloud-init logs ... write_files with permissions: '0600'").
 *
 * On success prints the rendered YAML to stdout and nothing else.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Files whose content `{{INCLUDE:<relative path>}}` lines pull in verbatim, indented to match
 *  the placeholder line's own indentation. Kept to an explicit allowlist rather than resolving
 *  arbitrary paths — this is the entire set the cloud-init template references. */
const INCLUDABLE_FILES = new Set([
  "units/xvfb.service",
  "units/openclaw-gateway.service",
  "units/desk-health.service",
  "units/desk-health.timer",
  "chromium-policy.json",
]);

const ALL_CAPS_PLACEHOLDER_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/;
const INCLUDE_LINE_RE = /^([ \t]*)\{\{INCLUDE:([^}]+)\}\}[ \t]*$/;
const OPENCLAW_CONFIG_JSON_LINE_RE = /^([ \t]*)\{\{OPENCLAW_CONFIG_JSON\}\}[ \t]*$/;

function fail(message) {
  process.stderr.write(`render-cloud-init: ${message}\n`);
  process.exit(1);
}

function readTrimmedFile(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    fail(`could not read ${label} at ${path}: ${error.message}`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    fail(`${label} at ${path} is empty`);
  }
  if (trimmed.includes("\n")) {
    fail(`${label} at ${path} must be a single line (secret files hold exactly one value)`);
  }
  return trimmed;
}

/** Indents `content` to `indent`, one line at a time, dropping a single trailing newline so the
 *  surrounding YAML block scalar (`content: |`) does not end with a blank line. */
function indentBlock(content, indent) {
  const lines = content.replace(/\n$/, "").split("\n");
  return lines.map((line) => (line.length > 0 ? `${indent}${line}` : line)).join("\n");
}

function resolveInclude(relativePath) {
  if (!INCLUDABLE_FILES.has(relativePath)) {
    fail(`template references an unknown include: ${relativePath}`);
  }
  return readFileSync(join(SCRIPT_DIR, relativePath), "utf8");
}

/** Renders `openclaw.json.tmpl` for one owner target and returns canonical (parsed + re-
 *  stringified) JSON text, so a malformed template — or a substitution that breaks JSON syntax —
 *  fails loudly here instead of shipping a Gateway that cannot parse its own config. */
function renderOpenClawConfig(ownerTarget) {
  const template = readFileSync(join(SCRIPT_DIR, "openclaw.json.tmpl"), "utf8");
  // The placeholder sits inside a JSON string in the template; substitute the JSON-escaped form
  // of the value so a target containing a quote or backslash cannot break the surrounding config.
  const escapedOwnerTarget = JSON.stringify(ownerTarget).slice(1, -1);
  const substituted = template.replaceAll("{{OWNER_TG_TARGET}}", escapedOwnerTarget);
  if (ALL_CAPS_PLACEHOLDER_RE.test(substituted)) {
    const [placeholder] = substituted.match(ALL_CAPS_PLACEHOLDER_RE) ?? [];
    fail(`openclaw.json.tmpl still has an unresolved placeholder: ${placeholder}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(substituted);
  } catch (error) {
    fail(`rendered openclaw.json.tmpl is not valid JSON: ${error.message}`);
  }
  return JSON.stringify(parsed, null, 2) + "\n";
}

function renderCloudInit(values) {
  const template = readFileSync(join(SCRIPT_DIR, "cloud-init.yaml.tmpl"), "utf8");
  const configJson = renderOpenClawConfig(values.OWNER_TG_TARGET);

  const withIncludes = template
    .split("\n")
    .map((line) => {
      const includeMatch = line.match(INCLUDE_LINE_RE);
      if (includeMatch) {
        const [, indent, relativePath] = includeMatch;
        return indentBlock(resolveInclude(relativePath.trim()), indent);
      }
      const configMatch = line.match(OPENCLAW_CONFIG_JSON_LINE_RE);
      if (configMatch) {
        const [, indent] = configMatch;
        return indentBlock(configJson, indent);
      }
      return line;
    })
    .join("\n");

  let rendered = withIncludes;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
}

function assertFullyRendered(rendered) {
  const placeholderMatch = rendered.match(ALL_CAPS_PLACEHOLDER_RE);
  if (placeholderMatch) {
    fail(`refusing to emit output: unresolved placeholder ${placeholderMatch[0]} remains`);
  }
  if (rendered.includes("{{INCLUDE:")) {
    fail("refusing to emit output: an unresolved {{INCLUDE:...}} remains");
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      "ts-authkey-file": { type: "string" },
      "tg-token-file": { type: "string" },
      "gateway-token-file": { type: "string" },
      "owner-target": { type: "string" },
      "git-ref": { type: "string" },
    },
  });

  for (const flag of ["name", "ts-authkey-file", "tg-token-file", "owner-target", "git-ref"]) {
    if (!values[flag]) {
      fail(`missing required --${flag}`);
    }
  }

  const tsAuthKey = readTrimmedFile(values["ts-authkey-file"], "Tailscale auth key");
  const tgBotToken = readTrimmedFile(values["tg-token-file"], "Telegram bot token");
  const gatewayToken = values["gateway-token-file"]
    ? readTrimmedFile(values["gateway-token-file"], "Gateway auth token")
    : randomBytes(32).toString("base64url");

  const rendered = renderCloudInit({
    DESK_NAME: values.name,
    TS_AUTHKEY: tsAuthKey,
    GIT_REF: values["git-ref"],
    OWNER_TG_TARGET: values["owner-target"],
    TG_BOT_TOKEN: tgBotToken,
    GATEWAY_TOKEN: gatewayToken,
  });

  assertFullyRendered(rendered);
  process.stdout.write(rendered);
}

main();
