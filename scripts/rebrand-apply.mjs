#!/usr/bin/env node

// Rewrites the literal product name "OpenClaw" -> "Vasudev" across the
// Vasudev rebrand's user-visible prose allowlist (docs, README, and the two
// bundled-plugin manifest fields that feed the Control UI channel picker).
// Internal identifiers (the `openclaw` npm/CLI/config namespace, `OPENCLAW_`
// env vars, `OpenClawConfig`-style type names, and any `openclaw.*` URL) are
// never touched: none of them are spelled "OpenClaw" at a word boundary, so
// the case-sensitive \bOpenClaw\b pattern already leaves them alone.
//
// Idempotent and safe to re-run after an `upstream/main` merge reintroduces
// the literal name in these same files/fields — a second run finds nothing
// left to change and exits clean.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OLD_NAME = "OpenClaw";
export const NEW_NAME = "Vasudev";

// Case-sensitive, word-boundary only. "OpenClawConfig"/"OpenClawPluginApi"
// (no boundary before "Config"/"PluginApi"), lowercase "openclaw" identifiers
// and commands, "OPENCLAW_" env vars, and "openclaw.ai"/"openclaw.org"/
// "openclaw/openclaw" URLs are never matched by this pattern. `.match()` and
// `.replace()` with a global regex always scan from the start regardless of
// prior `lastIndex` state, so one shared pattern is safe to reuse below.
const NAME_PATTERN = /\bOpenClaw\b/g;

function countAndReplace(text) {
  const matches = text.match(NAME_PATTERN);
  if (!matches) {
    return { text, count: 0 };
  }
  return { text: text.replace(NAME_PATTERN, NEW_NAME), count: matches.length };
}

const MARKDOWN_FENCE_RE = /^\s*(`{3,}|~{3,})/;
// Splits a line on inline code spans (`` `...` ``, including doubled ``` `` ```
// spans) so brand rewriting only ever touches the prose segments in between.
const INLINE_CODE_SPAN_RE = /(`+[^`]*`+)/;

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
 * everything else is prose and is rewritten. Non-Markdown files (the single
 * allowlisted `.ts` files) have no code-fence/code-span concept and are
 * rewritten line-for-line.
 */
export function rewriteProseContent(content, { isMarkdown = false } = {}) {
  let count = 0;
  let inFence = false;
  const lines = content.split("\n").map((line) => {
    if (isMarkdown) {
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

// JSON manifests carry both marketing copy and unrelated machine-readable
// fields (npm dependency names, config-schema help/label/default text this
// task does not migrate). Only these two keys are in scope: the top-level
// package description and the Control UI channel picker's blurb. Matching by
// key rather than scanning the whole file keeps dependency names, repository
// URLs, and un-migrated config help text untouched even though they sit in
// the same allowlisted file.
const JSON_KEYS_BY_BASENAME = new Map([
  ["openclaw.plugin.json", new Set(["description"])],
  ["package.json", new Set(["description", "blurb"])],
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

/** Dispatches one file to the prose or JSON-field rewrite by its path/basename. */
export function rewriteFileContent(relativePath, content) {
  const basename = path.basename(relativePath);
  if (JSON_KEYS_BY_BASENAME.has(basename)) {
    return rewriteJsonManifestContent(content, basename);
  }
  return rewriteProseContent(content, { isMarkdown: relativePath.endsWith(".md") });
}

// Single non-Markdown, non-manifest files carrying user-visible product
// wordmarks outside docs/README (pairing message, Telegram sender label,
// Bonjour advertised name). Task 3 already migrated these to read
// PRODUCT_NAME from the brand module; they are kept in the allowlist so the
// guard catches any future literal-string regression.
const SINGLE_FILE_TARGETS = [
  "src/channels/plugins/pairing-message.ts",
  "extensions/telegram/src/bot-message-context.session.ts",
  "extensions/bonjour/src/advertiser.ts",
];

// Documented, not yet enforced. Spec section 2 lists these as eventual guard
// inputs, but:
//  - ui/src/**/*.ts, ui/index.html, ui/public/manifest.webmanifest: a
//    concurrent worktree task owns ui/** right now; wire these in once that
//    work lands so the two efforts do not collide on the same files.
//  - src/cli/**/*.ts, src/wizard/**/*.ts, src/flows/**/*.ts: still contain
//    literal "OpenClaw" in onboarding/doctor prose and log strings (and the
//    tests asserting on them) that no task has migrated to read the brand
//    module yet; that is a source+test call-site migration, not a docs-prose
//    sweep, and is out of this task's scope. Tracked as a follow-up.
export const DEFERRED_ALLOWLIST_GLOBS = [
  "ui/src/**/*.ts",
  "ui/index.html",
  "ui/public/manifest.webmanifest",
  "src/cli/**/*.ts",
  "src/wizard/**/*.ts",
  "src/flows/**/*.ts",
];

function gitLsFiles(cwd, patterns) {
  const output = execFileSync("git", ["ls-files", "-z", "--", ...patterns], {
    cwd,
    encoding: "utf8",
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

/**
 * Resolves the full set of files this rebrand pass covers: docs/README
 * prose, the two bundled-plugin manifest fields, and the single already
 * brand-module-backed files. Restricting the manifest globs to exactly one
 * path segment below `extensions/` (git's `*` pathspec otherwise matches
 * across `/`) keeps this off nested qa-lab test-fixture manifests.
 */
export function collectTargetFiles(cwd) {
  const files = new Set();
  for (const file of gitLsFiles(cwd, ["docs/*.md"])) {
    if (!DOCS_EXCLUDED_PREFIX_RE.test(file)) {
      files.add(file);
    }
  }
  files.add("README.md");
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
  for (const file of SINGLE_FILE_TARGETS) {
    files.add(file);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

/**
 * Runs the rebrand pass over `files` (default: the full allowlist). In
 * `check` mode nothing is written; changed files are reported as violations
 * with a sample of their offending lines.
 */
export function runRebrand({ cwd = process.cwd(), check = false, files } = {}) {
  const targets = files ?? collectTargetFiles(cwd);
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
    const { content, count } = rewriteFileContent(relativePath, original);
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

/** CLI entry point; returns the process exit code. */
export function runRebrandCli(argv) {
  const check = argv.includes("--check");
  const fileArgs = argv.filter((arg) => !arg.startsWith("--"));
  const result = runRebrand({ check, files: fileArgs.length > 0 ? fileArgs : undefined });
  return printReport(result, { check });
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  process.exitCode = runRebrandCli(process.argv.slice(2));
}
