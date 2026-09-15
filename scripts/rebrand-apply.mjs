#!/usr/bin/env node

// Rewrites the literal product name "OpenClaw" -> "Vasudev", the mascot name
// "Clawd" -> "Vasu" (the orb's name), and, inside human-facing command
// examples only, the displayed CLI alias `openclaw ` -> `vasudev `, across the
// Vasudev rebrand's user-visible prose allowlist:
// docs, README, docs.json's `name` field, the two bundled-plugin manifest
// fields that feed the Control UI channel picker, and every TypeScript source
// under `src/**`, `extensions/*/**`, `packages/*/**` (one segment deep, at the
// plugin root or under its `src/`) and `ui/src/**`
// (a TypeScript-aware pass — see `rewriteTypeScriptContent` below).
//
// Internal identifiers are never touched, because none of them is spelled
// "OpenClaw" at a word boundary: the `openclaw` npm/CLI/config namespace,
// `~/.openclaw`, `openclaw.json`, `ai.openclaw.*` launchd labels,
// `_openclaw-gw` service types, `OPENCLAW_*` env vars, `OpenClawConfig`-style
// type names, and any `openclaw.ai`/`openclaw.org`/`openclaw/openclaw` URL.
// The case-sensitive `\bOpenClaw\b` pattern already leaves all of them alone;
// `test/scripts/check-brand.test.ts` pins that.
//
// What does need real rules is everything that *is* spelled "OpenClaw" at a
// word boundary but is not product prose. Those are the PROTECTED_TOKEN_RULES
// (wire/protocol tokens, git trailers, real repository paths, persisted
// transcript markers, shipped bundle/artifact filenames), the structural
// literal exclusions in `isStructuralStringLiteral` (module specifiers,
// property keys, enum members, `path.join` segments, HTTP header values,
// process-spawn arguments, `headers.set("X-…", …)` values), and the two cited
// per-file exclusion lists (`CROSS_BOUNDARY_EXCLUDED_FILES`,
// `EXCLUDED_LITERALS_BY_FILE`).
//
// Idempotent and safe to re-run after an `upstream/main` merge reintroduces
// the literal name in these same files/fields — a second run finds nothing
// left to change and exits clean.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export const OLD_NAME = "OpenClaw";
export const NEW_NAME = "Vasudev";
export const OLD_CLI_NAME = "openclaw";
export const NEW_CLI_NAME = "vasudev";
export const OLD_MASCOT_NAME = "Clawd";
export const NEW_MASCOT_NAME = "Vasu";

// The product name and the mascot name, both case-sensitive and
// word-boundary only. See the header comment for the full list of internal
// identifiers `\bOpenClaw\b` cannot match; `\bClawd\b` likewise cannot match
// `Clawdbot`, `clawd`, `clawdtributors`, or `discord.gg/clawd`. The mascot is
// the orb, and the orb's name is Vasu — the About page's "Wave hello to
// Clawd" and every other mention of the old mascot is product copy, so it
// moves with the rest of the prose. `.match()` and `.replace()` with a global
// regex always scan from the start regardless of prior `lastIndex` state, so
// these shared patterns are safe to reuse below.
// "an OpenClaw" reads wrong once the name starts with a consonant, and a
// mechanical rename would leave "an Vasudev" all over the product. The article
// is fixed before the name itself is replaced, so the rule can still see which
// name follows it.
const ARTICLE_RULES = [
  { pattern: /\ban (?=OpenClaw\b)/g, replacement: "a " },
  { pattern: /\bAn (?=OpenClaw\b)/g, replacement: "A " },
];

export const NAME_RULES = [
  { name: "product-name", pattern: /\bOpenClaw\b/g, replacement: NEW_NAME },
  { name: "mascot-name", pattern: /\bClawd\b/g, replacement: NEW_MASCOT_NAME },
];

// Top-level CLI commands. The displayed alias rewrite below only fires when
// the `openclaw` token is followed by one of these, which is what tells a
// command example ("run `openclaw doctor --fix`") apart from prose that names
// the lowercase internal namespace ("the openclaw config file", "openclaw
// runtime context"). Curated rather than derived: the program builds its
// command tree at runtime from plugin registrations, so there is no static
// list to import, and an over-broad list is exactly the failure mode this
// guards against.
const CLI_SUBCOMMANDS = [
  "acp",
  "agent",
  "agents",
  "approvals",
  "auth",
  "automations",
  "backup",
  "browser",
  "canvas",
  "channels",
  "claws",
  "completion",
  "config",
  "configure",
  "connect",
  "cron",
  "dashboard",
  "devices",
  "doctor",
  "duties",
  "explain",
  "fleet",
  "gateway",
  "health",
  "hooks",
  "logs",
  "mcp",
  "media",
  "memory",
  "message",
  "migrate",
  "models",
  "node",
  "nodes",
  "onboard",
  "package",
  "pairing",
  "peer",
  "plugins",
  "projects",
  "restart",
  "sandbox",
  "secrets",
  "security",
  "sessions",
  "setup",
  "skills",
  "status",
  "tasks",
  "telemetry",
  "tools",
  "transcripts",
  "triage",
  "tts",
  "tui",
  "uninstall",
  "update",
  "webhook",
];

// The displayed CLI alias. `package.json`'s `bin` map ships both `openclaw`
// and `vasudev` for the same launcher, and the owner rule (spec section 2b)
// is that commands shown to users spell the product: `vasudev doctor --fix`.
// Only a token that is *followed by a real subcommand* is a command example.
// The negative lookbehind keeps every non-command spelling intact:
//   - `/usr/bin/openclaw gateway` (a systemd ExecStart: the real binary path)
//   - `@openclaw/plugin-sdk`, `openclaw.json`, `~/.openclaw`, `_openclaw-gw`
//   - `C:\openclaw gateway`-style Windows paths
// This rewrite is applied to string/template-literal text only, never to
// comments (a comment documenting the installed binary should keep naming
// it) and never inside a process-spawn argument (see SPAWN_CALLEES).
// Root options may sit between the binary and its subcommand
// (`openclaw --profile staging gateway status`, and `formatCliCommand` itself
// inserts `--container <hint>`), so the lookahead skips a run of them before
// requiring a real subcommand. `openclaw --version` still has no subcommand
// after it and is therefore never rewritten.
const COMMAND_ALIAS_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.@/\\-])openclaw(?=(?: --[a-z][a-z0-9-]*(?:[= ][^\s'"\`]+)?)* (?:${CLI_SUBCOMMANDS.join("|")})\b)`,
  "g",
);

// The bare binary token as one element of a displayed argv
// (`formatCliArgs(["openclaw", "devices", "approve", id])`). Only ever applied
// to a literal already tagged as display text by DISPLAY_COMMAND_FORMATTERS.
const DISPLAY_BINARY_LITERAL_RE = /^(["'`])openclaw\1$/;

// A string literal whose entire content is one bare command line and nothing
// else (`"openclaw update"`, `"openclaw node restart"`) is a *value*, not
// prose: it is spawned, compared, or sent on the wire. Real examples in this
// tree are `Type.Literal("openclaw update")` in the Gateway protocol schema
// (which `ui/src/pages/new-session/discovery.ts` validates by exact equality,
// and external SDK clients pin) and `generatedBy: "openclaw secrets configure"`
// (persisted provenance). Prose that shows a command to a user always wraps it
// in a sentence or backticks, so it has other characters in the literal and is
// still rewritten. Consequence worth knowing: a structured command field the
// UI renders as-is keeps naming the real binary, which is still `openclaw`.
const BARE_COMMAND_LITERAL_RE =
  /^(["'`])openclaw(?:[ ]-{1,2}[A-Za-z0-9][A-Za-z0-9-]*|[ ][a-z][a-z0-9-]*)*\1$/;

function isBareCommandLiteral(slice) {
  return BARE_COMMAND_LITERAL_RE.test(slice);
}

// Helpers whose whole job is to render a command for a human to read, so a
// bare command literal passed to one is display text after all. `src/cli/
// command-format.ts`'s `formatCliCommand` decorates the command with the
// active `--profile`/`--container` before printing it; its `CLI_PREFIX_RE`
// accepts either alias, so renaming its argument keeps that decoration.
const DISPLAY_COMMAND_FORMATTERS = new Set(["formatCliCommand", "formatCliArgs"]);

function isDisplayCommandArgument(node) {
  // Walk out of an argv array literal too: `formatCliArgs(["openclaw", ...])`
  // passes the binary name as an element, not as the call's own argument.
  let current = node;
  let parent = current.parent;
  if (parent && ts.isArrayLiteralExpression(parent)) {
    current = parent;
    parent = current.parent;
  }
  if (!parent || !ts.isCallExpression(parent) || !parent.arguments.includes(current)) {
    return false;
  }
  const callee = callExpressionCalleeName(parent.expression);
  return Boolean(callee && DISPLAY_COMMAND_FORMATTERS.has(callee));
}

// Occurrences spelled "OpenClaw" at a word boundary that are *not* product
// prose: each is a value that crosses a boundary this rebrand does not own
// (the wire, the OS, a third-party service, a user's git history, or data
// written by an older build). Shielded before the name rewrite and restored
// afterwards, exactly like a fenced code block in Markdown. These are tokens
// and identifiers, not prose phrases: an earlier revision of this script
// carried a `PROTECTED_PROSE_PHRASES` list that shielded whole sentences and
// was removed for good reason (it hid unmigrated copy behind the guard).
// Every rule here is pinned by a test in `test/scripts/check-brand.test.ts`.
const PROTECTED_TOKEN_RULES = [
  {
    // Shipped bundle/installer/archive names. Native-app renaming is spec
    // Phase 3 (not this task): the actual files on disk, GitHub release
    // assets, and package manager listings are still literally named
    // "OpenClaw.app" / "OpenClaw-<version>-amd64.deb" / etc., so prose and
    // code naming "/Applications/OpenClaw.app" or "OpenClaw-Android.apk"
    // must keep saying that — renaming only the reference would name a file
    // that does not exist. Matches a bare OpenClaw.<ext> bundle name (the
    // extension whitelist below) or an OpenClaw-<anything>.<ext> artifact
    // filename (any extension, since release assets vary: .apk, .deb,
    // .AppImage, -SHA256SUMS.txt, ...). Deliberately requires a literal
    // extension after the hyphenated form so a hyphenated *adjective* like
    // "OpenClaw-managed" (never a filename) still renames.
    name: "bundle-artifact",
    pattern:
      /\bOpenClaw(?:\.(?:app|dmg|exe|msi|pkg|zip)|-[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+)\b/g,
  },
  {
    // The HTTP User-Agent product token `OpenClaw/<version>`: a value the
    // remote service parses and logs (extensions/msteams/src/user-agent.ts
    // sends `teams.ts[apps]/<sdk> OpenClaw/<version>`). Recognised by the
    // slash-then-version shape so prose that happens to slash two names
    // together ("OpenClaw/Codex tool names", "Packaged OpenClaw/Bun hosts")
    // still renames.
    name: "user-agent-product-token",
    pattern: /\bOpenClaw\/(?=\$\{|<|\d)/g,
  },
  {
    // The `OpenClaw-Publication: <request id>` git commit trailer. It is
    // written into commits in the *user's* repository and read back to
    // recognise an already-published commit; commits made by earlier builds
    // carry the old spelling forever, so the reader must keep matching it.
    name: "git-commit-trailer",
    pattern: /\bOpenClaw-Publication\b/g,
  },
  {
    // A hyphenated HTTP header name whose middle segment is the product name
    // (`X-OpenClaw-Cli-Capture-Key`, `X-OpenClaw-Session-Key`). Header names
    // are wire tokens: the sender and receiver must spell them identically,
    // and clients outside this tree (the CLI capture path, paired nodes,
    // the Control UI) already send the current spelling. Source spells most
    // of them lowercase, which the case-sensitive rules never touch anyway;
    // this catches the canonical-cased form wherever it is written out.
    name: "http-header-name-token",
    pattern: /(?<=\b[A-Za-z][A-Za-z0-9]*-)OpenClaw(?=-[A-Za-z0-9])/g,
  },
  {
    // A node/client identity token: a string literal whose *entire* content is
    // one hyphenated `OpenClaw-<Segment>` identifier. `src/shared/node-match.ts`
    // classifies a paired node as the current app with
    // `clientId.toLowerCase().startsWith("openclaw-")`, and the desktop, iOS and
    // Android clients each announce themselves with one of these ids on the
    // wire, so the token is a value the rebrand does not own. Anchored to the
    // literal's own quotes (inner padding allowed, because the matcher trims)
    // so a hyphenated *adjective* inside a sentence — "an OpenClaw-managed
    // host" — is still ordinary prose and still renames.
    name: "client-identity-literal",
    pattern: /(?<=^["'`][ \t]*)OpenClaw(?=-[A-Za-z0-9]+[ \t]*["'`]$)/g,
  },
  {
    // The canonical upstream GitHub owner/repo slug. `openclaw/openclaw` is
    // lowercase and never matched, but the capitalized slug appears in clone
    // URLs and derived project keys (`github.com/OpenClaw/OpenClaw`), which
    // `src/projects`'s registry normalizes and compares. It has to be shielded
    // as one token: `repository-path-segment` below only protects a segment
    // followed by `/`, so the trailing half would rename on its own and leave
    // a slug that identifies no repository.
    name: "repository-slug",
    pattern: /\bOpenClaw\/OpenClaw\b/g,
  },
  {
    // A real path segment inside this repository or a shipped bundle
    // (`apps/macos/Sources/OpenClaw/AppProfile.swift`,
    // `apps/shared/OpenClawKit/...`). Requires a preceding path segment so a
    // sentence never matches. Only the `OpenClaw` segment is shielded; the
    // surrounding prose still renames.
    name: "repository-path-segment",
    pattern: /(?:[A-Za-z0-9._-]+\/)+OpenClaw(?=\/)/g,
  },
  {
    // The legacy protected-runtime-context header. It is embedded in
    // transcripts persisted by older builds and matched verbatim when
    // stripping leaked internal context out of stored sessions
    // (src/tasks/task-status.ts, src/agents/internal-runtime-context.ts's
    // LEGACY_INTERNAL_CONTEXT_HEADER). Renaming the matcher would stop it
    // stripping old sessions — a privacy regression, not a cosmetic one.
    name: "persisted-context-header",
    pattern: /\bOpenClaw runtime context \(internal\):/g,
  },
];

// Protected tokens that only apply inside one tree, where the same words mean
// something different from the rest of the repo.
const TREE_SCOPED_PROTECTED_TOKEN_RULES = [
  {
    // Everything under src/daemon/ is service lifecycle: "OpenClaw Gateway" and
    // "OpenClaw Node" there are the Windows scheduled-task name, the systemd
    // Description and the Startup-folder launcher filename of services already
    // installed on operators' machines — read back by `schtasks /Query`, by the
    // unit-file parser, and by the extra-service scan. src/daemon/constants.ts
    // is excluded whole for the same reason; this covers its callers and tests
    // without stranding their ordinary prose.
    name: "daemon-service-label",
    pathPattern: /^src\/daemon\//,
    pattern: /\bOpenClaw (?:Gateway|Node)\b/g,
  },
  {
    // The same tree also *executes* and *detects* the binary: a generated unit's
    // ExecStart, a Startup-folder launcher's command line, and the launchd plist
    // and rc-file fixtures the extra-service scan matches all name the installed
    // binary, which is still `openclaw`. Displayed remediation in this tree
    // reaches the user through `formatCliCommand`, which the alias rewrite covers
    // separately.
    name: "daemon-binary-invocation",
    pathPattern: /^src\/daemon\//,
    pattern: /\bopenclaw(?= (?:gateway|node)\b)/g,
  },
];

function protectedTokenRulesFor(relativePath) {
  const scoped = TREE_SCOPED_PROTECTED_TOKEN_RULES.filter((rule) =>
    rule.pathPattern.test(relativePath),
  );
  return scoped.length === 0 ? PROTECTED_TOKEN_RULES : [...scoped, ...PROTECTED_TOKEN_RULES];
}

/**
 * Applies the brand rewrite (and, when `commandAlias` is set, the displayed
 * CLI alias rewrite) to one span of prose, shielding every protected-token
 * match first and restoring it afterwards.
 */
function countAndReplace(text, { commandAlias = false, tokenRules = PROTECTED_TOKEN_RULES } = {}) {
  let shielded = text;
  const placeholders = [];
  for (const rule of tokenRules) {
    shielded = shielded.replace(rule.pattern, (match) => {
      const token = ` PROTECTED_TOKEN_${placeholders.length} `;
      placeholders.push(match);
      return token;
    });
  }
  let count = commandAlias ? (shielded.match(COMMAND_ALIAS_RE)?.length ?? 0) : 0;
  for (const rule of NAME_RULES) {
    count += shielded.match(rule.pattern)?.length ?? 0;
  }
  if (count === 0) {
    return { text, count: 0 };
  }
  let rewritten = shielded;
  for (const rule of ARTICLE_RULES) {
    rewritten = rewritten.replace(rule.pattern, rule.replacement);
  }
  for (const rule of NAME_RULES) {
    rewritten = rewritten.replace(rule.pattern, rule.replacement);
  }
  if (commandAlias) {
    rewritten = rewritten.replace(COMMAND_ALIAS_RE, NEW_CLI_NAME);
  }
  placeholders.forEach((phrase, index) => {
    rewritten = rewritten.split(` PROTECTED_TOKEN_${index} `).join(phrase);
  });
  return { text: rewritten, count };
}

const MARKDOWN_FENCE_RE = /^\s*(`{3,}|~{3,})/;
// Splits a line on inline code spans (`` `...` ``, including doubled ``` `` ```
// spans) so brand rewriting only ever touches the prose segments in between.
const INLINE_CODE_SPAN_RE = /(`+[^`]*`+)/;

// Bot/script-managed content blocks: regenerated wholesale by their owning
// tool from an external source (e.g. README's clawtributors wall, filled in
// from the GitHub API), not hand-authored prose. Rewriting inside one edits
// content that is not this task's to edit -- the clawtributors block ships a
// contributor's own chosen GitHub display name (`alt="Steve (OpenClaw)"`),
// not product copy -- and is not idempotent against the block's own
// regeneration, which would silently overwrite the rewrite back to
// "OpenClaw" on its next run anyway. Treated as opaque exactly like a fenced
// code block: a start-marker line arms it, an end-marker line disarms it,
// nothing between is touched. Matches both README's visible
// `<!-- clawtributors:start -->`/`<!-- clawtributors:end -->` pair and its
// `<!-- clawtributors:hidden:start` / `clawtributors:hidden:end -->` variant
// (one continuous HTML comment, so the start line has no closing `-->`), plus
// a generic `<!-- generated -->`/`<!-- /generated -->` convention for any
// future block that opts in the same way.
const GENERATED_BLOCK_START_RE = /<!--\s*(?:clawtributors(?::hidden)?:start\b|generated\s*-->)/;
const GENERATED_BLOCK_END_RE = /(?:clawtributors(?::hidden)?:end\s*-->|<!--\s*\/generated\s*-->)/;

// Note on link fragments: Mintlify auto-generates a page's heading (and
// `<Step title="...">`) anchors from their rendered text, so renaming a
// heading here can shift another page's `...#old-slug` link target. An
// earlier version of this script tried to keep those fragments in sync with
// a blind `openclaw` -> `vasudev` substring rewrite; that broke links whose
// target heading legitimately keeps "openclaw" (a CLI command, config key,
// or filename quoted in backticks, e.g. `` `openclaw security audit` ``,
// which this same rewrite correctly never touches). Telling those two cases
// apart requires resolving the actual target file's current heading text,
// which this script does not do. Anchor drift is instead caught by
// `pnpm docs:check-links:anchors` and fixed by hand against the real target.
/**
 * Rewrites OpenClaw -> Vasudev in Markdown/plain-text prose. Markdown fenced
 * code blocks (``` ... ```) and inline code spans (`...`) are left verbatim;
 * everything else is prose and is rewritten. Non-Markdown files have no
 * code-fence/code-span concept and are rewritten line-for-line.
 */
export function rewriteProseContent(content, { isMarkdown = false } = {}) {
  let count = 0;
  let inFence = false;
  let inGeneratedBlock = false;
  const lines = content.split("\n").map((line) => {
    if (isMarkdown) {
      if (inGeneratedBlock) {
        if (GENERATED_BLOCK_END_RE.test(line)) {
          inGeneratedBlock = false;
        }
        return line;
      }
      if (GENERATED_BLOCK_START_RE.test(line)) {
        inGeneratedBlock = true;
        return line;
      }
      if (MARKDOWN_FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }
      const segments = line.split(INLINE_CODE_SPAN_RE);
      const rewritten = segments.map((segment, index) => {
        // Odd indices are the backtick-delimited code spans the capturing
        // split above pulled out; only even (prose) segments are rewritten.
        if (index % 2 === 1) {
          return segment;
        }
        const result = countAndReplace(segment);
        count += result.count;
        return result.text;
      });
      return rewritten.join("");
    }
    const result = countAndReplace(line);
    count += result.count;
    return result.text;
  });
  return { content: lines.join("\n"), count };
}

// Callees whose string arguments are filesystem path segments, never prose.
// `path.join(root, "OpenClaw", FILE)` names a real directory on disk (the
// legacy OAuth sidecar under `%APPDATA%\OpenClaw` and
// `~/Library/Application Support/OpenClaw`); rewriting it makes the doctor
// look for a directory that was never created.
const PATH_BUILDER_METHODS = new Set(["join", "resolve", "relative", "normalize"]);
// Objects those methods must be called on. Required, because `resolve` alone
// also names `Promise.resolve("OpenClaw update failed")` — prose, not a path.
const PATH_BUILDER_OBJECT_RE = /^(?:node_?)?path(?:Module)?$|^(?:posix|win32)$/i;

// Callees that start a process. A string argument here is an executable name
// or a shell command line, not display text, so neither the brand rewrite nor
// the displayed-alias rewrite may touch it.
const SPAWN_CALLEES = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "execa",
  "execaSync",
]);

// HTTP header name casing (`User-Agent`, `X-OpenRouter-Title`,
// `MM-API-Source`, `X-BILLING-INVOKE-ORIGIN`). A string literal assigned to a
// property with this shape is a header value read by a remote service, not
// copy: it identifies this client on third-party dashboards, billing records
// and rate-limit buckets.
// Canonical HTTP header casing, which requires the leading segment to start
// upper-case. Deliberately not case-insensitive: a lowercase hyphenated key is
// far more likely to be an ordinary discriminant whose value is real copy
// (`{ "newer-schema": "a newer OpenClaw build" }` in
// src/infra/startup-maintenance-required.ts) than a header.
const HTTP_HEADER_NAME_RE = /^[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+$/;

// The Headers/Map call form of the same rule: `headers.set("X-OpenRouter-Title",
// "OpenClaw")`. The property-key path above only sees an object literal, so the
// setter call needs its own check — the remote service reads the value either
// way. Matched by the canonical header casing of the *first* argument, so an
// ordinary `map.set("some-key", "OpenClaw prose")` is untouched.
const HEADER_SETTER_METHODS = new Set(["set", "append"]);

function isHeaderSetterValueArgument(call, valueNode) {
  if (call.arguments[1] !== valueNode) {
    return false;
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !HEADER_SETTER_METHODS.has(callee.name.text)) {
    return false;
  }
  const headerName = call.arguments[0];
  return Boolean(
    headerName && ts.isStringLiteral(headerName) && HTTP_HEADER_NAME_RE.test(headerName.text),
  );
}

// A SCREAMING_SNAKE property key means the value is an environment variable's
// value, not display copy: `{ OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway" }`
// is the name of a service already installed on the machine (see
// src/daemon/constants.ts, excluded for the same reason), and
// `{ OPENCLAW_BOT_NAME: "OpenClaw" }` is what the process reads back. Renaming
// one side of an environment handshake breaks it.
const ENV_VAR_KEY_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

// Property keys whose value is a process command line, argv, or executable
// name. Those are matched against the *real* binary: `src/infra/ports-format.ts`
// classifies a listener as the Gateway with `raw.includes("openclaw")`, so a
// fixture's `commandLine: "node dist/index.js openclaw gateway"` has to keep
// spelling the binary or the classification it exercises never happens.
const PROCESS_COMMAND_PROPERTY_NAMES = new Set([
  "argv",
  "bin",
  "binName",
  "cmd",
  "command",
  "commandLine",
  "exec",
  "executable",
  "program",
  "programArguments",
]);

function callExpressionCalleeName(expression) {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
    return expression.name.text;
  }
  return undefined;
}

function isPathBuilderCall(call) {
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.name)) {
    return false;
  }
  if (!PATH_BUILDER_METHODS.has(expression.name.text)) {
    return false;
  }
  let object = expression.expression;
  while (ts.isPropertyAccessExpression(object)) {
    object = object.name;
  }
  return ts.isIdentifier(object) && PATH_BUILDER_OBJECT_RE.test(object.text);
}

/**
 * Returns true when `node` (a StringLiteral) sits in a structural position —
 * a module specifier (`import`/`export ... from`, `require(...)`, dynamic
 * `import(...)`, `import ... = require(...)`), an import attribute
 * (`with { type: "json" }`), a quoted object/interface/class property key, an
 * enum member's name/value, a `path.join(...)` segment, a process-spawn
 * argument, or the value of an HTTP-header-shaped property — rather than
 * user-facing prose. These read as ordinary string literals to the parser but
 * are identifiers/paths/wire values in disguise (e.g.
 * `import x from "../OpenClawKit/x.json"`, `enum E { A = "OpenClawA" }`,
 * `{ "X-OpenRouter-Title": "OpenClaw" }`), so the brand rewrite must never
 * touch them.
 */
function isStructuralStringLiteral(node) {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (
    (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
    parent.moduleSpecifier === node
  ) {
    return true;
  }
  if (ts.isExternalModuleReference(parent) && parent.expression === node) {
    return true;
  }
  if (ts.isCallExpression(parent)) {
    if (parent.arguments[0] === node) {
      if (ts.isImportCall(parent)) {
        return true;
      }
      if (ts.isIdentifier(parent.expression) && parent.expression.text === "require") {
        return true;
      }
    }
    if (parent.arguments.includes(node)) {
      if (isPathBuilderCall(parent)) {
        return true;
      }
      const callee = callExpressionCalleeName(parent.expression);
      if (callee && SPAWN_CALLEES.has(callee)) {
        return true;
      }
    }
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  // Walk out of an expression that only *computes* the property's value (a
  // ternary picking a profile-qualified label, a template building it, a
  // concatenation) so the key still governs the literals inside it.
  let valueNode = node;
  let valueParent = valueNode.parent;
  while (
    valueParent &&
    (ts.isConditionalExpression(valueParent) ||
      ts.isTemplateExpression(valueParent) ||
      ts.isTemplateSpan(valueParent) ||
      ts.isParenthesizedExpression(valueParent) ||
      (ts.isBinaryExpression(valueParent) &&
        valueParent.operatorToken.kind === ts.SyntaxKind.PlusToken))
  ) {
    valueNode = valueParent;
    valueParent = valueNode.parent;
  }
  if (
    valueParent &&
    ts.isCallExpression(valueParent) &&
    isHeaderSetterValueArgument(valueParent, valueNode)
  ) {
    return true;
  }
  if (
    valueParent &&
    ts.isPropertyAssignment(valueParent) &&
    valueParent.initializer === valueNode
  ) {
    const key = valueParent.name;
    const keyText = ts.isStringLiteral(key) || ts.isIdentifier(key) ? key.text : undefined;
    if (
      keyText &&
      (HTTP_HEADER_NAME_RE.test(keyText) ||
        ENV_VAR_KEY_RE.test(keyText) ||
        PROCESS_COMMAND_PROPERTY_NAMES.has(keyText))
    ) {
      return true;
    }
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const key = parent.name;
    const keyText = ts.isStringLiteral(key)
      ? key.text
      : ts.isIdentifier(key)
        ? key.text
        : undefined;
    if (
      keyText &&
      (HTTP_HEADER_NAME_RE.test(keyText) ||
        ENV_VAR_KEY_RE.test(keyText) ||
        PROCESS_COMMAND_PROPERTY_NAMES.has(keyText))
    ) {
      return true;
    }
  }
  if (ts.isEnumMember(parent) && (parent.name === node || parent.initializer === node)) {
    return true;
  }
  if (ts.isLiteralTypeNode(parent)) {
    return true;
  }
  return false;
}

/**
 * Walks the parsed `sourceFile` and returns every [start, end) range (sorted,
 * non-overlapping) that is eligible prose: string/template literal text
 * (excluding the structural positions above) and JSX text. Identifiers, type
 * names, and property/import/enum names are never yielded because they are
 * not literal-kind nodes — the AST itself is the exclusion mechanism, not a
 * regex denylist. Each range is tagged `literal` or `comment` so the
 * displayed-alias rewrite can apply to strings only.
 */
function collectLiteralRanges(sourceFile) {
  const ranges = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node)) {
      if (!isStructuralStringLiteral(node)) {
        ranges.push([
          node.getStart(sourceFile),
          node.getEnd(),
          isDisplayCommandArgument(node) ? "command-display" : "literal",
        ]);
      }
      return;
    }
    if (ts.isRegularExpressionLiteral(node)) {
      // A regex literal that spells the brand is matching text this tree
      // produces (a thrown message, a rendered hint, the CLI's own
      // `--version` line), so it moves with the string it matches. The brand
      // and command names carry no regex metacharacters, so substituting them
      // inside the pattern is safe. Files whose patterns parse *external*
      // output are excluded whole (see CROSS_BOUNDARY_EXCLUDED_FILES: the
      // systemd/schtasks installers parse installed unit files).
      ranges.push([node.getStart(sourceFile), node.getEnd(), "literal"]);
      return;
    }
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail ||
      ts.isJsxText(node)
    ) {
      ranges.push([node.getStart(sourceFile), node.getEnd(), "literal"]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return ranges;
}

/**
 * Returns every comment range in `sourceFile` by asking `ts.getLeadingCommentRanges`
 * for the trivia immediately before every node's full start (which includes
 * every keyword/punctuation position, since a composite node's full start is
 * its first token's full start) plus the trivia before end-of-file. This is
 * deliberately *not* a standalone re-scan of the raw text: a plain sequential
 * `Scanner.scan()` pass does not know when a `${...}` substitution inside a
 * template literal ends and template text resumes (that requires the
 * parser's own brace-depth tracking via `reScanTemplateToken`), so it
 * mis-tokenizes — and silently drops comments in — everything after the
 * first template literal with an interpolation. Querying comment trivia by
 * position against the already-correctly-parsed tree sidesteps that
 * entirely. A comment can be reachable from more than one node's full start
 * (e.g. an `ExpressionStatement` and its first-token child can share a full
 * start), so duplicate ranges are possible here; the caller's sorted
 * forward-cursor pass already skips any range starting before the cursor,
 * which absorbs the duplicates for free.
 */
function collectCommentRanges(sourceFile) {
  const ranges = [];
  const collectAt = (pos) => {
    const comments = ts.getLeadingCommentRanges(sourceFile.text, pos);
    if (!comments) {
      return;
    }
    for (const comment of comments) {
      ranges.push([comment.pos, comment.end, "comment"]);
    }
  };
  const visit = (node) => {
    collectAt(node.getFullStart());
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  collectAt(sourceFile.endOfFileToken.getFullStart());
  return ranges;
}

/**
 * Rewrites OpenClaw -> Vasudev inside TypeScript source, restricted to
 * string-literal text, template-literal text, and comments — the only
 * positions the TypeScript compiler API structurally distinguishes as prose
 * rather than code. The displayed CLI alias rewrite additionally applies to
 * string/template text only, never to comments. Identifiers
 * (`OpenClawConfig`), import/require/dynamic-import specifiers, quoted
 * property keys, enum member names/values, `path.join` segments, spawn
 * arguments and HTTP header values are therefore never touched even when they
 * spell "OpenClaw" at a word boundary; see `isStructuralStringLiteral`.
 */
export function rewriteTypeScriptContent(content, relativePath) {
  const scriptKind = relativePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : relativePath.endsWith(".mjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );
  const ranges = [
    ...collectLiteralRanges(sourceFile),
    ...collectCommentRanges(sourceFile),
  ].toSorted((left, right) => left[0] - right[0]);
  const excludedLiterals = EXCLUDED_LITERALS_BY_FILE.get(relativePath);
  const tokenRules = protectedTokenRulesFor(relativePath);

  let count = 0;
  let output = "";
  let cursor = 0;
  for (const [start, end, kind] of ranges) {
    if (start < cursor) {
      // Defensive: literal and comment ranges are structurally disjoint, but
      // never let an unexpected overlap corrupt output by double-emitting.
      continue;
    }
    output += content.slice(cursor, start);
    const slice = content.slice(start, end);
    if (excludedLiterals?.has(slice)) {
      output += slice;
      cursor = end;
      continue;
    }
    if (kind === "command-display" && DISPLAY_BINARY_LITERAL_RE.test(slice)) {
      output += slice.replace("openclaw", NEW_CLI_NAME);
      count += 1;
      cursor = end;
      continue;
    }
    const result = countAndReplace(slice, {
      commandAlias:
        kind === "command-display" || (kind === "literal" && !isBareCommandLiteral(slice)),
      tokenRules,
    });
    output += result.text;
    count += result.count;
    cursor = end;
  }
  output += content.slice(cursor);
  return { content: output, count };
}

// Directory prefixes whose `.ts`/`.tsx` files are rewritten with the
// TypeScript-aware pass above rather than the plain-text pass. Spec section
// 2b: every user-facing string in these trees is in scope.
const TYPESCRIPT_AWARE_PREFIXES = ["src/", "extensions/", "packages/", "ui/src/"];

// Test and fixture files are never rewritten by the default apply, only by an
// explicit `--tests` run. A test asserts against real runtime output; a
// mechanical rewrite of its expectation cannot by itself verify the call site
// it exercises was migrated too. `--tests` is therefore only used
// *after* the matching production chunk is rewritten and the chunk's Vitest
// lane is run, so every rewritten expectation is proved against real output
// by a green lane (and any expectation whose producer is excluded above fails
// that lane and is reverted by hand — see the report's decision table).
// `brand:check` does scan these files, so a settled tree stays settled.
// Matches `*.test.ts`/`*.test.tsx` (including compound suffixes like
// `*.process.test.ts`), `*.test-support.ts`, `*.test-helpers.ts`,
// `*.test-harness.ts`, `*.test-utils.ts`, `*.cases.ts` (extracted
// `it.each`/assertion tables), any `__snapshots__` or `test-utils` directory,
// and any path segment/filename containing "fixture".
const TEST_OR_FIXTURE_RE =
  /(?:\.test(?:-support|-helpers|-harness|-utils)?\.tsx?$|\.cases\.tsx?$|(?:^|\/)(?:__snapshots__|test-utils)(?:\/|$)|fixture)/i;

// Production (non-test) files under the enforced trees excluded outright,
// because their "OpenClaw" occurrences are values that cross a boundary this
// rebrand does not own, not display text. Rewriting one side of such a value
// silently changes behaviour while looking like an ordinary prose rename. An
// exact, reviewable file list — not a phrase shield — because each entry can
// be checked against its cited real occurrence; remove the entry once the
// boundary itself is renamed (a separate, breaking phase with a migration).
const CROSS_BOUNDARY_EXCLUDED_FILES = new Set([
  // Windows scheduled-task names ("OpenClaw Gateway", "OpenClaw Node") and
  // systemd/launchd service descriptions. These identify services that are
  // *already installed* on operators' machines: the installer, uninstaller,
  // status and update paths all look them up by this exact name, so renaming
  // the constant orphans every existing installation. The whole file is
  // service identity; it carries no user prose.
  "src/daemon/constants.ts",
  // Parses and rewrites `Description=OpenClaw Gateway (...)` inside unit
  // files already written to /etc/systemd and ~/.config/systemd.
  "src/daemon/systemd-install.ts",
  // Default `Description=` for a generated unit; must stay byte-identical to
  // src/daemon/constants.ts's label or install/inspect stops recognising it.
  "src/daemon/systemd-unit.ts",
  // Default schtasks task description; same contract as the unit Description.
  "src/daemon/schtasks-install.ts",
  // Documents the real `\OpenClaw Gateway` task path that `schtasks /query`
  // prints, which the parser strips by exact prefix.
  "src/daemon/inspect.ts",
  // Tests the generators above and nothing else, so every occurrence is the
  // same OS service identity.
  "src/daemon/constants.test.ts",
]);

// Individual string literals (matched by their exact source text, quotes
// included) excluded inside one file. Used where a file is mostly prose but
// carries one value that crosses a boundary, so a whole-file exclusion would
// strand real copy.
const EXCLUDED_LITERALS_BY_FILE = new Map([
  [
    // `OPENCLAW_ATTRIBUTION_PRODUCT` is the app name this client reports to
    // third-party model providers (OpenRouter's `X-Title`, and
    // `X-BILLING-INVOKE-ORIGIN`). Providers key attribution, leaderboards
    // and billing records on the registered name.
    "src/agents/provider-attribution.ts",
    new Set(['"OpenClaw"']),
  ],
  [
    // `clientInfo.title` in the Codex app-server `initialize` handshake: read
    // by the third-party Codex binary, not by this product's UI.
    "extensions/codex/src/app-server/client.ts",
    new Set(['"OpenClaw"']),
  ],
  [
    // `serviceName` in Codex `thread/start`. Codex scopes stored credentials
    // and telemetry by it; changing it re-prompts every operator for auth.
    "extensions/codex/src/app-server/bounded-turn.ts",
    new Set(['"OpenClaw"']),
  ],
  [
    // Same `serviceName` contract as bounded-turn.ts.
    "extensions/codex/src/app-server/thread-requests.ts",
    new Set(['"OpenClaw"']),
  ],
  [
    // The exact command key the dev-channel update spawns; the mock matches it
    // verbatim to inject a failing config validation.
    "src/infra/update-runner.test.ts",
    new Set(['"pnpm openclaw config validate --json"']),
  ],
  [
    // A User-Agent fixture, echoed back by the redirect-header helper under test.
    "src/infra/net/fetch-guard.ssrf.test.ts",
    new Set(['"OpenClaw-Test/1.0"']),
  ],
  [
    // `${params.packageName}` is the npm package name, still `openclaw`, so the
    // recovery line this pins is not copy.
    "src/infra/package-update-steps.recovery.test.ts",
    new Set(['"restored previous openclaw package and affected launchers"']),
  ],
  [
    // The `MM-API-Source` header value this client sends to MiniMax. The
    // producer's own literal is protected by the header-value rule; the
    // assertion argument is not reachable by it.
    "src/infra/provider-usage.fetch.minimax.test.ts",
    new Set(['"OpenClaw"']),
  ],
  [
    // The canonical Windows task name these cases assert `applyCliProfileEnv`
    // drops when switching profiles. src/daemon/constants.ts owns the label and
    // is excluded, so the expectation has to pin its real output; the assertion
    // argument is not reachable by the env-var key rule.
    "src/cli/profile.test.ts",
    new Set(['"OpenClaw Node"', '"OpenClaw Gateway"']),
  ],
  [
    // The generated Windows task name inside the restart helper's PowerShell
    // script. src/daemon/constants.ts owns the label and is excluded, so these
    // expectations pin its real output.
    "src/cli/update-cli/restart-helper.test.ts",
    new Set([
      "\"$taskName = 'OpenClaw Gateway'\"",
      "\"$taskName = 'OpenClaw Gateway (production)'\"",
    ]),
  ],
  [
    // Test input, not copy: `"OpenClaw"` normalizes to `openclaw`, which is the
    // reserved system-agent id these cases prove is refused. The reserved id is
    // the lowercase internal namespace and does not move, so the input cannot
    // either or the case stops exercising the refusal.
    "src/system-agent/setup-apply.test.ts",
    new Set(['"OpenClaw"']),
  ],
  [
    // Same reserved-id input as setup-apply.test.ts.
    "src/system-agent/operations.test.ts",
    new Set(['"OpenClaw"']),
  ],
  ...[
    // The `X-OpenRouter-Title` value this client sends to OpenRouter, asserted
    // against the real request headers. The producer's own literal is
    // protected by the header-setter rule; a lowercase `x-openrouter-title`
    // expectation key and a `toBe` argument are not reachable by it.
    "extensions/openrouter/index.test.ts",
    "extensions/openrouter/image-generation-provider.test.ts",
    "extensions/openrouter/media-understanding-provider.test.ts",
    "extensions/openrouter/speech-provider.test.ts",
  ].map((file) => [file, new Set(['"OpenClaw"'])]),
  [
    // The `path` a policy health finding reports. Its producer
    // (extensions/policy/src/doctor/policy-evidence-finding.ts) holds the bare
    // command literal `"openclaw config"`, which the bare-command rule keeps
    // as a value, so the expectation has to match it.
    "extensions/policy/src/doctor/register.base.test-utils.ts",
    new Set(['"openclaw config"']),
  ],
  [
    // The pairing guidance printed by the Chrome extension's own
    // `relay-core.js`. That module is plain JavaScript inside the packed
    // extension and is not in the allowlist, so its command example still
    // spells the real binary and the expectation has to match it.
    "extensions/browser/chrome-extension/modules/relay-core.test.ts",
    new Set(['"openclaw browser extension pair"']),
  ],
  [
    // `${configuredRuntimeId}` is an agent-runtime id, and the reserved system
    // runtime is spelled `openclaw`. The displayed-alias rule reads
    // "openclaw agent ..." as a command example because `agent` is a real
    // subcommand, so these expectations of the producer's interpolated message
    // (extensions/reef/src/setup.ts) have to be pinned.
    "extensions/reef/src/setup.test.ts",
    new Set([
      '"left openai/gpt-5.6-terra on the openclaw agent runtime"',
      '"openai/gpt-5.6-terra currently uses the openclaw agent runtime. Reef OAuth requires codex; change this shared model runtime?"',
    ]),
  ],
  [
    // The `serviceName` Codex scopes credentials by, asserted against the real
    // request these cases build. Its producer
    // (extensions/codex/src/app-server/bounded-turn.ts) is excluded above, so
    // the expectation has to keep spelling it.
    "extensions/codex/media-understanding-provider.test.ts",
    new Set(['"OpenClaw"']),
  ],
  [
    // The ACP bridge command line. `isOpenClawBridgeCommand` in
    // extensions/acpx/src/runtime.ts matches the real executable
    // (`OPENCLAW_BRIDGE_EXECUTABLE = "openclaw"`, subcommand `acp`), so a
    // fixture command that spells anything else stops routing through the
    // bridge-safe delegate these cases exercise.
    "extensions/acpx/src/runtime.test.ts",
    new Set([
      // Test input, not copy: the probed agent name normalizes to the
      // `openclaw` agent id the fixture registry resolves to the bridge
      // command, the same reserved lowercase namespace as
      // src/system-agent/setup-apply.test.ts's input.
      '"  OpenClaw  "',
      '"openclaw acp"',
      '"env OPENCLAW_HIDE_BANNER=1 OPENCLAW_SUPPRESS_NOTES=1 openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token --session agent:main:main"',
    ]),
  ],
]);

function isUnderTypeScriptAwarePrefix(relativePath) {
  return TYPESCRIPT_AWARE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function isTypeScriptAwareTarget(relativePath, { includeTests = false } = {}) {
  if (ROOT_LAUNCHER_FILES.includes(relativePath)) {
    return true;
  }
  if (!/\.tsx?$/.test(relativePath)) {
    return false;
  }
  if (!isUnderTypeScriptAwarePrefix(relativePath)) {
    return false;
  }
  if (CROSS_BOUNDARY_EXCLUDED_FILES.has(relativePath)) {
    return false;
  }
  return includeTests || !TEST_OR_FIXTURE_RE.test(relativePath);
}

// JSON manifests carry both marketing copy and unrelated machine-readable
// fields (npm dependency names, config-schema help/label/default text this
// task does not migrate). Only these keys are in scope: the top-level
// package description, the Control UI channel picker's blurb, and
// docs.json's site `name`. Matching by key rather than scanning the whole
// file keeps dependency names, repository URLs, un-migrated config help
// text, and docs.json's `logo`/`favicon`/`colors` (a later phase swaps these
// for the Vasudev orb/palette) untouched even though they sit in the same
// allowlisted file.
const JSON_KEYS_BY_BASENAME = new Map([
  ["openclaw.plugin.json", new Set(["description"])],
  ["package.json", new Set(["description", "blurb"])],
  ["docs.json", new Set(["name"])],
]);
const JSON_LINE_RE = /^(\s*"([A-Za-z0-9_-]+)":\s*)"((?:[^"\\]|\\.)*)"(,?\s*)$/;

/** Rewrites OpenClaw -> Vasudev inside one JSON manifest's allowlisted keys only. */
export function rewriteJsonManifestContent(content, basename) {
  const allowedKeys = JSON_KEYS_BY_BASENAME.get(basename);
  if (!allowedKeys) {
    throw new Error(`rewriteJsonManifestContent: no brand key allowlist for "${basename}"`);
  }
  let count = 0;
  const lines = content.split("\n").map((line) => {
    const match = line.match(JSON_LINE_RE);
    if (!match || !allowedKeys.has(match[2])) {
      return line;
    }
    const [, prefix, , value, suffix] = match;
    const result = countAndReplace(value);
    if (result.count === 0) {
      return line;
    }
    count += result.count;
    return `${prefix}"${result.text}"${suffix}`;
  });
  return { content: lines.join("\n"), count };
}

/**
 * Locale-catalog mode (`--locales`): the mechanical product-name swap only.
 * The 30 non-English Control UI catalogs are generated from translation
 * memory, so this is an interim so their brand line stops naming the upstream
 * product; a real translation run is still owed (see the task report). No
 * command-alias rewrite, no comment rewrite, no structural analysis — a plain
 * `\bOpenClaw\b` -> `Vasudev` pass and nothing else, so a reviewer can diff
 * it by eye.
 */
export function rewriteLocaleContent(content) {
  let count = 0;
  let rewritten = content;
  for (const rule of NAME_RULES) {
    count += rewritten.match(rule.pattern)?.length ?? 0;
    rewritten = rewritten.replace(rule.pattern, rule.replacement);
  }
  return count === 0 ? { content, count: 0 } : { content: rewritten, count };
}

/** Dispatches one file to the TypeScript-aware, prose, or JSON-field rewrite by its path/basename. */
export function rewriteFileContent(relativePath, content, { includeTests = false } = {}) {
  const basename = path.basename(relativePath);
  if (JSON_KEYS_BY_BASENAME.has(basename)) {
    return rewriteJsonManifestContent(content, basename);
  }
  if (
    (/\.tsx?$/.test(relativePath) && isUnderTypeScriptAwarePrefix(relativePath)) ||
    ROOT_LAUNCHER_FILES.includes(relativePath)
  ) {
    // A test/fixture file (outside an explicit `--tests` run), or a file on
    // the cross-boundary exclusion list, must never be touched by any pass,
    // including a fallback to the plain-text one below.
    if (!isTypeScriptAwareTarget(relativePath, { includeTests })) {
      return { content, count: 0 };
    }
    return rewriteTypeScriptContent(content, relativePath);
  }
  return rewriteProseContent(content, { isMarkdown: relativePath.endsWith(".md") });
}

// Single non-Markdown, non-manifest files carrying user-visible product
// wordmarks outside docs/README (pairing message, Telegram sender label,
// Bonjour advertised name). Task 3 already migrated these to read
// PRODUCT_NAME from the brand module; they are kept in the allowlist so the
// guard catches any future literal-string regression.
// The root launchers run before any TypeScript loads, and they print to the
// user: the unsupported-Node refusal, the Node-runtime recovery reason, and the
// `--version` fast path. They are rewritten with the same TypeScript-aware pass
// (the compiler API parses `.mjs` as JavaScript), so identifiers and module
// specifiers in them are as safe as anywhere else.
const ROOT_LAUNCHER_FILES = [
  "openclaw.mjs",
  "node-runtime-recovery.mjs",
  "node-runtime-update.mjs",
  "node-version.mjs",
];

const SINGLE_FILE_TARGETS = [
  "src/channels/plugins/pairing-message.ts",
  "extensions/telegram/src/bot-message-context.session.ts",
  "extensions/bonjour/src/advertiser.ts",
];

function gitLsFiles(cwd, patterns) {
  const output = execFileSync("git", ["ls-files", "-z", "--", ...patterns], {
    cwd,
    encoding: "utf8",
    // The source globs list every TypeScript file in the repo; the default
    // 1 MiB pipe buffer is not enough for that many NUL-separated paths.
    maxBuffer: 256 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

// docs/superpowers/** holds this repo's planning/spec documents for the
// superpowers skill workflow (plans, specs, SDD ledgers) — including this
// very rebrand's own plan and spec, which *discuss* "OpenClaw" as the string
// being replaced. It sits under docs/ by convention only: it is absent from
// docs.json's navigation (not part of the published docs site) and rewriting
// it turns self-referential sentences like `every "OpenClaw" -> "Vasudev"`
// into nonsense (`every "Vasudev" -> "Vasudev"`). Excluded outright rather
// than made idempotent-safe, since there is no correct rewrite for prose
// that names the old string as a subject rather than using it as the brand.
const DOCS_EXCLUDED_PREFIX_RE = /^docs\/superpowers\//;

// Docs pages whose subject *is* the old name, the same class of self-reference
// as docs/superpowers above. Renaming inside them does not rebrand anything; it
// falsifies a record or breaks a joke, and there is no correct rewrite:
//   - docs/releases/**: shipped release notes quoting real PR titles. The PRs
//     say what they say, and a past release shipped what it shipped.
//   - docs/start/lore.md and docs/reference/credits.md: the rename history and
//     the credit to the old mascot by name.
//   - docs/reference/templates/*.dev.md: the `--dev` persona is "C-3PO —
//     Clawd's 3rd Protocol Observer"; renaming half of an acronym leaves
//     nonsense. Retiring that persona is its own change, not a rename.
const DOCS_SELF_REFERENCE_RE =
  /^docs\/(?:releases\/|start\/lore\.md$|reference\/credits\.md$|reference\/templates\/[^/]+\.dev\.md$)/;

// The upstream MIT notice rendered by the About page's Licences disclosure.
// Spec section 2b makes this the single place in the product where the
// upstream name may appear, and only when the reader opens it on purpose;
// `ui/src/i18n/locales/brand.test.ts` asserts the notice is still there, so
// the exemption cannot go dead.
export const UPSTREAM_LICENCE_NOTICE_FILE = "ui/src/pages/about/upstream-licence.ts";

// The test that proves the licence exemption is still in place has to be able to
// spell the name it is asserting on, so it is excluded alongside the notice.
const LICENCE_EXEMPTION_TEST_FILE = "ui/src/i18n/locales/brand.test.ts";

// The Control UI locale catalogs. English is source-owned copy (rewritten by
// the ordinary TypeScript-aware pass); the other 30 are generated from
// translation memory and are handled only by `--locales`, so a normal apply
// or check never touches them.
// A generated catalog is `<language tag>.ts` and nothing else: the directory
// also holds English shards and `brand.test.ts`, which `--locales` must not
// touch (it asserts against the literal name on purpose).
const NON_ENGLISH_LOCALE_RE =
  /^ui\/src\/i18n\/locales\/(?!en(?:-|\.))[a-z]{2,3}(?:-[A-Za-z]{2,4})?\.ts$/;
const LOCALE_GLOB = "ui/src/i18n/locales/*.ts";

// TypeScript sources in scope, per spec section 2b. Git's default (non-
// `:(glob)`) pathspec matching runs `*` through `fnmatch(3)` without
// `FNM_PATHNAME`, so a single `*` already crosses `/` — `src/*.ts` matches
// `src/cli/program/help.ts`. The `extensions/`/`packages/` patterns are
// re-filtered below to exactly one path segment before the source file, which
// keeps the sweep off nested qa-lab test-fixture packages.
const TYPESCRIPT_AWARE_GLOBS = [
  "src/*.ts",
  "src/*.tsx",
  "extensions/*/src/*.ts",
  "extensions/*/src/*.tsx",
  "extensions/*/*.ts",
  "extensions/*/*.tsx",
  "packages/*/src/*.ts",
  "packages/*/src/*.tsx",
  "packages/*/*.ts",
  "packages/*/*.tsx",
  "ui/src/*.ts",
];
const NESTED_SOURCE_TREE_RE = /^(?:extensions|packages)\/[^/]+\/src\//;
// Many bundled plugins and workspace packages keep their sources at the
// plugin root instead of under `src/` (`extensions/anthropic/auth.runtime.ts`,
// `extensions/migrate-hermes/config-mcp.ts`), and their user-facing strings
// are in scope exactly as they are one directory down. Exactly one segment
// before the filename, for the same reason as NESTED_SOURCE_TREE_RE: a nested
// fixture package's root sources are not this repo's product copy.
const NESTED_ROOT_SOURCE_RE = /^(?:extensions|packages)\/[^/]+\/[^/]+\.tsx?$/;

function isInScopeTypeScriptPath(file) {
  if (file.startsWith("extensions/") || file.startsWith("packages/")) {
    return NESTED_SOURCE_TREE_RE.test(file) || NESTED_ROOT_SOURCE_RE.test(file);
  }
  return true;
}

/**
 * Resolves the full set of files this rebrand pass covers: docs/README
 * prose, docs.json's `name` field, the two bundled-plugin manifest fields,
 * every in-scope TypeScript source, and the single already brand-module-backed
 * files. `includeTests` adds test/fixture files (always true for the guard,
 * true for the apply only under `--tests`).
 */
export function collectTargetFiles(cwd, { includeTests = false } = {}) {
  const files = new Set();
  for (const file of gitLsFiles(cwd, ["docs/*.md"])) {
    if (!DOCS_EXCLUDED_PREFIX_RE.test(file) && !DOCS_SELF_REFERENCE_RE.test(file)) {
      files.add(file);
    }
  }
  files.add("README.md");
  files.add("docs/docs.json");
  for (const file of gitLsFiles(cwd, ["extensions/*/openclaw.plugin.json"])) {
    if (/^extensions\/[^/]+\/openclaw\.plugin\.json$/.test(file)) {
      files.add(file);
    }
  }
  for (const file of gitLsFiles(cwd, ["extensions/*/package.json"])) {
    if (/^extensions\/[^/]+\/package\.json$/.test(file)) {
      files.add(file);
    }
  }
  for (const file of gitLsFiles(cwd, TYPESCRIPT_AWARE_GLOBS)) {
    if (!isInScopeTypeScriptPath(file)) {
      continue;
    }
    if (
      file === UPSTREAM_LICENCE_NOTICE_FILE ||
      file === LICENCE_EXEMPTION_TEST_FILE ||
      NON_ENGLISH_LOCALE_RE.test(file)
    ) {
      continue;
    }
    if (isTypeScriptAwareTarget(file, { includeTests })) {
      files.add(file);
    }
  }
  for (const file of SINGLE_FILE_TARGETS) {
    files.add(file);
  }
  for (const file of ROOT_LAUNCHER_FILES) {
    files.add(file);
  }
  return [...files].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves the 30 generated non-English Control UI locale catalogs. */
export function collectLocaleFiles(cwd) {
  return gitLsFiles(cwd, [LOCALE_GLOB])
    .filter((file) => NON_ENGLISH_LOCALE_RE.test(file))
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Runs the rebrand pass over `files` (default: the full allowlist). In
 * `check` mode nothing is written; changed files are reported as violations
 * with a sample of their offending lines. `check` always includes test files;
 * `apply` includes them only when `includeTests` is set.
 *
 * @param {{
 *   cwd?: string,
 *   check?: boolean,
 *   files?: string[],
 *   includeTests?: boolean,
 *   locales?: boolean,
 *   only?: string[],
 * }} [options]
 */
export function runRebrand({
  cwd = process.cwd(),
  check = false,
  files,
  includeTests = false,
  locales = false,
  only = [],
} = {}) {
  const includeTestFiles = check || includeTests;
  let targets =
    files ??
    (locales
      ? collectLocaleFiles(cwd)
      : collectTargetFiles(cwd, { includeTests: includeTestFiles }));
  if (only && only.length > 0) {
    const prefixes = only.map((entry) => entry.replace(/\*+$/, ""));
    targets = targets.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)));
  }
  const changes = [];
  const violations = [];
  for (const relativePath of targets) {
    const absolutePath = path.join(cwd, relativePath);
    let original;
    try {
      original = readFileSync(absolutePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const { content, count } = locales
      ? rewriteLocaleContent(original)
      : rewriteFileContent(relativePath, original, { includeTests: includeTestFiles });
    if (count === 0) {
      continue;
    }
    if (check) {
      // Diffed against the rewritten line, not a raw NAME_TEST_RE scan: a
      // fenced code block or inline code span can legitimately still say
      // "OpenClaw" (never rewritten) on the same line as a real violation,
      // and a raw scan would surface both as if each were offending.
      const originalLines = original.split("\n");
      const rewrittenLines = content.split("\n");
      const offendingLines = originalLines
        .map((line, index) => ({ line, number: index + 1, after: rewrittenLines[index] }))
        .filter(({ line, after }) => line !== after)
        .slice(0, 5)
        .map(({ line, number }) => ({ line, number }));
      violations.push({ file: relativePath, count, offendingLines });
      continue;
    }
    writeFileSync(absolutePath, content, "utf8");
    changes.push({ file: relativePath, count });
  }
  return { changes, violations };
}

function printReport({ changes, violations }, { check }) {
  if (check) {
    if (violations.length === 0) {
      console.log('brand check: clean — no allowlisted file contains a literal "OpenClaw".');
      return 0;
    }
    console.error(`brand check: found "${OLD_NAME}" in ${violations.length} file(s):`);
    for (const violation of violations) {
      console.error(`- ${violation.file} (${violation.count} occurrence(s))`);
      for (const { number, line } of violation.offendingLines) {
        console.error(`    ${number}: ${line.trim()}`);
      }
    }
    return 1;
  }
  if (changes.length === 0) {
    console.log("brand apply: no changes — every allowlisted file is already on-brand.");
    return 0;
  }
  let total = 0;
  for (const change of changes) {
    console.log(`${change.file}: ${change.count} change(s)`);
    total += change.count;
  }
  console.log(`brand apply: ${total} change(s) across ${changes.length} file(s).`);
  return 0;
}

/**
 * Parses the CLI surface: `--check`, `--tests`, `--locales`, repeated
 * `--only <prefix>` (chunked runs: `--only src/gateway`), and bare file
 * arguments (an explicit file list overrides the allowlist).
 */
export function parseRebrandArgv(argv) {
  const only = [];
  const files = [];
  let check = false;
  let includeTests = false;
  let locales = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--tests") {
      includeTests = true;
      continue;
    }
    if (arg === "--locales") {
      locales = true;
      continue;
    }
    if (arg === "--only") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("rebrand-apply: --only requires a path prefix or glob");
      }
      only.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--only=")) {
      only.push(arg.slice("--only=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`rebrand-apply: unknown option "${arg}"`);
    }
    files.push(arg);
  }
  return { check, includeTests, locales, only, files: files.length > 0 ? files : undefined };
}

/** CLI entry point; returns the process exit code. */
export function runRebrandCli(argv) {
  const parsed = parseRebrandArgv(argv);
  const result = runRebrand(parsed);
  return printReport(result, { check: parsed.check });
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  process.exitCode = runRebrandCli(process.argv.slice(2));
}
