#!/usr/bin/env node
/**
 * Renders `cloud-init.yaml.tmpl` into a droplet-ready `#cloud-config` for one desk.
 *
 * Usage:
 *   node deploy/desk/render-cloud-init.mjs \
 *     --name <desk> --ts-authkey-file <f> [--profile owner|client] \
 *     [--tg-token-file <f>] [--owner-target <id>] --git-ref <ref> \
 *     [--gateway-token-file <f>] [--repo-url <url>] [--preflight] \
 *     > /tmp/<desk>.cloud-init.yaml
 *
 * Reads every secret input from a file (never from argv, so they never land in shell history or
 * `ps`): the Tailscale auth key, the Telegram bot token (owner profile only, see `--profile`
 * below), and — optionally — a pre-chosen Gateway auth token. When `--gateway-token-file` is
 * omitted a random one is generated here.
 *
 * `--profile` picks WHOSE desk this is, which is the only thing that changes the embedded
 * openclaw.json:
 *   owner  (default) — the operator's own desk: `openclaw.json.tmpl`, with the Telegram channel,
 *          the named agents, their bindings and the Gmail hooks already wired up.
 *   client — a client's desk: `openclaw.client.json.tmpl`, which carries ONLY desk plumbing
 *          (Gateway auth/bind/Tailscale, the Gateway-token secret provider, the browser SSRF
 *          allowlist, the bundled plugin entries and tools.alsoAllow). No channels, agents,
 *          bindings or hooks: the client meets the same onboarding a fresh install gives
 *          anyone — Model Setup, the first-conversation naming ritual, and Telegram added from
 *          Settings — instead of inheriting the operator's setup. `--tg-token-file` and
 *          `--owner-target` are then unused (nothing would read them) and may be omitted.
 *
 * The desk clones the operator's own fork, never a name hardcoded in this file: `--repo-url`
 * (or the `DESK_FORK_REPO_URL` env var) overrides it explicitly, and by default it is read from
 * the `origin` remote of the checkout running this renderer.
 *
 * `--preflight` renders a cloud-init meant for a local test VM instead of a real desk: it skips
 * every Tailscale runcmd step (the VM has no real tailnet to join) and sets
 * `gateway.tailscale.mode: "off"` (claiming Tailscale Serve without a joined tailnet makes the
 * Gateway exit instead of starting). See `deploy/desk/preflight-local.sh`.
 *
 * Substitutes every `{{PLACEHOLDER}}` in `cloud-init.yaml.tmpl` (including the config file it
 * embeds from `openclaw.json.tmpl`) and refuses to print anything if an ALL_CAPS `{{PLACEHOLDER}}`
 * or an unresolved `{{INCLUDE:…}}` survives — see docs/superpowers/specs/2026-09-14-hosted-desk-
 * design.md §10 ("Secrets never in cloud-init logs ... write_files with permissions: '0600'").
 *
 * On success prints the rendered YAML to stdout and nothing else.
 */
import { execFileSync } from "node:child_process";
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
  "units/desk-metadata-guard.service",
  "chromium-policy.json",
]);

const ALL_CAPS_PLACEHOLDER_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/;
const INCLUDE_LINE_RE = /^([ \t]*)\{\{INCLUDE:([^}]+)\}\}[ \t]*$/;
const OPENCLAW_CONFIG_JSON_LINE_RE = /^([ \t]*)\{\{OPENCLAW_CONFIG_JSON\}\}[ \t]*$/;
// Conditional sections: a `{{#IF:NAME}}` line and its `{{/IF}}` line each own a whole line, so a
// kept section renders byte-for-byte as if the markers were never there (the marker lines are
// simply dropped) and a dropped one takes its blank lines with it instead of leaving a gap.
const IF_OPEN_LINE_RE = /^[ \t]*\{\{#IF:([A-Z][A-Z0-9_]*)\}\}[ \t]*$/;
const IF_CLOSE_LINE_RE = /^[ \t]*\{\{\/IF\}\}[ \t]*$/;

/** The two desk profiles, and which optional cloud-init sections each one renders. Keys here are
 *  the complete set of `{{#IF:NAME}}` names the template may use; an unknown one is a template
 *  bug and fails the render rather than silently dropping the block. */
const PROFILES = {
  owner: { TELEGRAM: true, GMAIL_HOOKS: true },
  client: { TELEGRAM: false, GMAIL_HOOKS: false },
};
const DEFAULT_PROFILE = "owner";
/** Config template per profile — see the `--profile` note in this file's header comment. */
const CONFIG_TEMPLATE_BY_PROFILE = {
  owner: "openclaw.json.tmpl",
  client: "openclaw.client.json.tmpl",
};

// `--name` becomes both a YAML scalar (`hostname: {{DESK_NAME}}`) and a raw shell argument
// (`--hostname {{DESK_NAME}}` inside a runcmd string), so it is restricted to characters that
// are safe unquoted in both contexts — the same shape doctl/cloud-init expect for a hostname.
const DESK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// `--git-ref` is interpolated raw into a shell-executed `git checkout {{GIT_REF}}` runcmd line.
// Git ref syntax allows more than this, but this covers every ref/branch/tag an operator would
// legitimately pass and excludes shell metacharacters; a leading `-` is rejected separately so
// the value can never be parsed as a `git checkout` option.
const GIT_REF_RE = /^[A-Za-z0-9._/-]{1,128}$/;
// The fork repo URL is interpolated raw into a shell-executed `git clone ... <url>` runcmd line;
// restricted to a plain https:// host/owner/repo shape (no ".git" suffix, no credentials, no
// shell metacharacters) — the same shape every legitimate git host URL takes.
const FORK_REPO_URL_RE = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

/** `--name` lands unquoted in both a YAML scalar and a shell-executed runcmd argument; refuse
 *  anything that isn't a plain lowercase hostname-shaped token before it ever reaches the
 *  template. */
function validateDeskName(name) {
  if (!DESK_NAME_RE.test(name)) {
    fail(
      `--name ${JSON.stringify(name)} is invalid: must match ${DESK_NAME_RE} ` +
        "(lowercase letters, digits, and hyphens; must start with a letter or digit; max 63 chars)",
    );
  }
}

/** `--git-ref` is interpolated raw into a shell-executed `git checkout {{GIT_REF}}` runcmd
 *  line; refuse anything containing shell metacharacters or that could be parsed as a `git
 *  checkout` option. */
function validateGitRef(ref) {
  if (ref.startsWith("-")) {
    fail(`--git-ref ${JSON.stringify(ref)} is invalid: must not start with '-'`);
  }
  if (!GIT_REF_RE.test(ref)) {
    fail(
      `--git-ref ${JSON.stringify(ref)} is invalid: must match ${GIT_REF_RE} ` +
        "(letters, digits, '.', '_', '/', '-'; max 128 chars)",
    );
  }
}

/** `git@host:owner/repo(.git)` -> `https://host/owner/repo` — cloud-init clones over anonymous
 *  HTTPS, never SSH (no key on the desk), so an operator's own SSH-style origin remote still
 *  resolves to something the desk can actually clone. */
function normalizeForkRepoUrl(raw) {
  const trimmed = raw.trim().replace(/\.git$/, "");
  const sshMatch = /^git@([^:]+):(.+)$/.exec(trimmed);
  return sshMatch ? `https://${sshMatch[1]}/${sshMatch[2]}` : trimmed;
}

/** The desk clones the operator's own fork, never a hardcoded name — `--repo-url` and
 *  `DESK_FORK_REPO_URL` both override; the default reads the `origin` remote of the checkout
 *  running this renderer, which is exactly "this fork" every other doc here refers to. */
function resolveForkRepoUrl(repoUrlFlag) {
  const explicit = repoUrlFlag?.trim() || process.env.DESK_FORK_REPO_URL?.trim();
  if (explicit) {
    return explicit;
  }
  try {
    const raw = execFileSync("git", ["-C", SCRIPT_DIR, "remote", "get-url", "origin"], {
      encoding: "utf8",
    });
    return normalizeForkRepoUrl(raw);
  } catch (error) {
    fail(
      "could not determine the fork to clone on the desk: no --repo-url or DESK_FORK_REPO_URL " +
        `given, and \`git remote get-url origin\` failed: ${error.message}`,
    );
  }
}

/** `--repo-url`/`DESK_FORK_REPO_URL` is interpolated raw into a shell-executed `git clone ...
 *  <url>` runcmd line; refuse anything that is not a plain https:// host/owner/repo URL. */
function validateForkRepoUrl(url) {
  if (!FORK_REPO_URL_RE.test(url)) {
    fail(
      `fork repo URL ${JSON.stringify(url)} is invalid: must match ${FORK_REPO_URL_RE} ` +
        '(an https:// URL shaped like "https://<host>/<owner>/<repo>", no ".git" suffix, ' +
        "no credentials, no shell metacharacters)",
    );
  }
}

/** Reads this repo's own `package.json` "packageManager" field verbatim (version + `+sha512...`
 *  integrity suffix) so `corepack prepare` on the box verifies the exact pinned pnpm binary,
 *  not just its version number. */
function readPnpmPackageManager() {
  const packageJsonPath = join(SCRIPT_DIR, "..", "..", "package.json");
  let packageManager;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    packageManager = pkg.packageManager;
  } catch (error) {
    fail(`could not read packageManager from ${packageJsonPath}: ${error.message}`);
  }
  if (typeof packageManager !== "string" || !/^pnpm@\d/.test(packageManager)) {
    fail(`${packageJsonPath} "packageManager" is not a pinned pnpm version: ${packageManager}`);
  }
  return packageManager;
}

/** Drops every `{{#IF:NAME}}` … `{{/IF}}` block whose section is off for this profile, and the
 *  marker lines of the ones that stay. Blocks do not nest: a desk section is either rendered or
 *  not, and a nested one would only make it harder to see which profile ships what. */
function applyConditionalSections(template, sections) {
  const kept = [];
  let open = null;
  const lines = template.split("\n");
  for (const [index, line] of lines.entries()) {
    const openMatch = line.match(IF_OPEN_LINE_RE);
    if (openMatch) {
      const [, name] = openMatch;
      if (open) {
        fail(`template nests {{#IF:${name}}} inside {{#IF:${open.name}}} at line ${index + 1}`);
      }
      if (!(name in sections)) {
        fail(`template references an unknown conditional section: ${name}`);
      }
      open = { name, keep: sections[name] };
      continue;
    }
    if (IF_CLOSE_LINE_RE.test(line)) {
      if (!open) {
        fail(`template has a {{/IF}} with no matching {{#IF:...}} at line ${index + 1}`);
      }
      open = null;
      continue;
    }
    if (!open || open.keep) {
      kept.push(line);
    }
  }
  if (open) {
    fail(`template has an unterminated {{#IF:${open.name}}}`);
  }
  return kept.join("\n");
}

/** Renders this profile's openclaw.json template and returns canonical (parsed + re-stringified)
 *  JSON text, so a malformed template — or a substitution that breaks JSON syntax — fails loudly
 *  here instead of shipping a Gateway that cannot parse its own config. Every value is
 *  substituted JSON-escaped: each placeholder sits inside a JSON string, so a value carrying a
 *  quote or backslash must not be able to break out of it. */
function renderOpenClawConfig(profile, substitutions) {
  const templateName = CONFIG_TEMPLATE_BY_PROFILE[profile];
  let substituted = readFileSync(join(SCRIPT_DIR, templateName), "utf8");
  for (const [key, value] of Object.entries(substitutions)) {
    substituted = substituted.replaceAll(`{{${key}}}`, JSON.stringify(value).slice(1, -1));
  }
  if (ALL_CAPS_PLACEHOLDER_RE.test(substituted)) {
    const [placeholder] = substituted.match(ALL_CAPS_PLACEHOLDER_RE) ?? [];
    fail(`${templateName} still has an unresolved placeholder: ${placeholder}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(substituted);
  } catch (error) {
    fail(`rendered ${templateName} is not valid JSON: ${error.message}`);
  }
  return JSON.stringify(parsed, null, 2) + "\n";
}

function renderCloudInit({ profile, configSubstitutions, values }) {
  const template = applyConditionalSections(
    readFileSync(join(SCRIPT_DIR, "cloud-init.yaml.tmpl"), "utf8"),
    PROFILES[profile],
  );
  const configJson = renderOpenClawConfig(profile, configSubstitutions);

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
  // Conditional markers carry a `#`/`/`, so the ALL_CAPS check above never sees them; a stray one
  // would otherwise ship into cloud-init as a bare YAML line.
  if (rendered.includes("{{#IF:") || rendered.includes("{{/IF}}")) {
    fail("refusing to emit output: an unresolved conditional section marker remains");
  }
  // DigitalOcean's user-data path re-encoded UTF-8 comment characters (an em dash, a section
  // sign) so that cloud-init saw byte 0x80, refused the YAML blob, and applied an EMPTY config
  // (observed 2026-09-14: "Failed loading yaml blob. unacceptable character #x0080"). Keep the
  // document 7-bit clean; the secret files are validated as single lines but can carry anything,
  // so check the final render, not just the template.
  const nonAscii = rendered.match(/[^\x00-\x7F]/);
  if (nonAscii) {
    const index = rendered.indexOf(nonAscii[0]);
    const line = rendered.slice(0, index).split("\n").length;
    fail(
      `refusing to emit output: non-ASCII character U+${nonAscii[0].codePointAt(0).toString(16).padStart(4, "0")} at line ${line} - cloud-init user-data must be plain ASCII`,
    );
  }
}

/** What each of the three Tailscale-dependent runcmd lines becomes: the real command against
 *  `desk`'s hostname (`{{DESK_NAME}}` is already validated hostname-shaped, so no injection
 *  risk from inlining it directly), or — under `--preflight` — a single inert comment in its
 *  place, since a local VM has no real tailnet to join, and the un-guarded `tailscale set
 *  --operator` / `tailscale funnel` commands would otherwise fail cloud-init's own error count
 *  even though the rest of provisioning succeeded (observed 2026-09-15). */
function tailscaleRuncmdLines(deskName, preflight) {
  const skipped = "# preflight: tailscale skipped";
  if (preflight) {
    return { up: skipped, operator: skipped, funnel: skipped };
  }
  return {
    up: `- 'tailscale up --authkey "$(cat /root/ts-authkey)" --hostname ${deskName} --timeout 180s || echo "desk: tailscale up FAILED (bad or consumed auth key?)" >&2'`,
    operator: "- tailscale set --operator=openclaw",
    funnel: "- tailscale funnel --bg --https=8443 --set-path=/gmail-pubsub http://127.0.0.1:8788",
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      profile: { type: "string" },
      "ts-authkey-file": { type: "string" },
      "tg-token-file": { type: "string" },
      "gateway-token-file": { type: "string" },
      "owner-target": { type: "string" },
      "git-ref": { type: "string" },
      "repo-url": { type: "string" },
      preflight: { type: "boolean", default: false },
    },
  });

  const profile = values.profile ?? DEFAULT_PROFILE;
  if (!(profile in PROFILES)) {
    fail(
      `--profile ${JSON.stringify(profile)} is invalid: must be one of ` +
        `${Object.keys(PROFILES).join(", ")}`,
    );
  }
  const sections = PROFILES[profile];

  // A client desk renders no Telegram channel, so it needs neither the bot token nor the owner
  // target; the owner's own desk still requires both.
  const requiredFlags = ["name", "ts-authkey-file", "git-ref"];
  if (sections.TELEGRAM) {
    requiredFlags.push("tg-token-file", "owner-target");
  }
  for (const flag of requiredFlags) {
    if (!values[flag]) {
      fail(`missing required --${flag}`);
    }
  }
  // Ignoring a flag silently would leave an operator believing a client desk answers a bot it
  // never configured; say so instead, and render the client profile as documented.
  if (!sections.TELEGRAM) {
    for (const flag of ["tg-token-file", "owner-target"]) {
      if (values[flag]) {
        process.stderr.write(
          `render-cloud-init: ignoring --${flag}: the "${profile}" profile renders no Telegram ` +
            "channel (the client adds Telegram from Settings)\n",
        );
      }
    }
  }

  validateDeskName(values.name);
  validateGitRef(values["git-ref"]);
  const forkRepoUrl = resolveForkRepoUrl(values["repo-url"]);
  validateForkRepoUrl(forkRepoUrl);

  const tsAuthKey = readTrimmedFile(values["ts-authkey-file"], "Tailscale auth key");
  const gatewayToken = values["gateway-token-file"]
    ? readTrimmedFile(values["gateway-token-file"], "Gateway auth token")
    : randomBytes(32).toString("base64url");

  const preflight = Boolean(values.preflight);
  const tailscaleRuncmd = tailscaleRuncmdLines(values.name, preflight);

  // A real desk's Gateway claims Tailscale Serve for the Control UI; --preflight's local VM never
  // joins a real tailnet, so claiming Serve there makes the Gateway exit ("Logged out.") instead
  // of starting.
  const configSubstitutions = { GATEWAY_TAILSCALE_MODE: preflight ? "off" : "serve" };
  const templateValues = {
    DESK_NAME: values.name,
    TS_AUTHKEY: tsAuthKey,
    GIT_REF: values["git-ref"],
    FORK_REPO_URL: forkRepoUrl,
    GATEWAY_TOKEN: gatewayToken,
    PNPM_PACKAGE_MANAGER: readPnpmPackageManager(),
    TAILSCALE_UP_RUNCMD: tailscaleRuncmd.up,
    TAILSCALE_OPERATOR_RUNCMD: tailscaleRuncmd.operator,
    TAILSCALE_FUNNEL_RUNCMD: tailscaleRuncmd.funnel,
  };
  if (sections.TELEGRAM) {
    templateValues.TG_BOT_TOKEN = readTrimmedFile(values["tg-token-file"], "Telegram bot token");
    configSubstitutions.OWNER_TG_TARGET = values["owner-target"];
  }
  if (sections.GMAIL_HOOKS) {
    // hooks.enabled requires hooks.token (the Gmail push endpoint's bearer); minted per desk, it
    // lives only in the root:root 0600 /etc/openclaw/secrets/hooks-token.env the Gateway unit
    // hands systemd, and openclaw.json references it as ${HOOKS_TOKEN}.
    templateValues.HOOKS_TOKEN = randomBytes(32).toString("base64url");
  }

  const rendered = renderCloudInit({ profile, configSubstitutions, values: templateValues });

  assertFullyRendered(rendered);
  process.stdout.write(rendered);
}

main();
