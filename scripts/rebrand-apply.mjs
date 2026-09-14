#!/usr/bin/env node

// Rewrites the literal product name "OpenClaw" -> "Vasudev" across the
// Vasudev rebrand's user-visible prose allowlist: docs, README, the two
// bundled-plugin manifest fields that feed the Control UI channel picker,
// and the CLI help/wizard/doctor/Control-UI prose in `src/cli/**`,
// `src/wizard/**`, `src/flows/**`, and `ui/**` (a TypeScript-aware pass —
// see `rewriteTypeScriptContent` below). Internal identifiers (the
// `openclaw` npm/CLI/config namespace, `OPENCLAW_` env vars,
// `OpenClawConfig`-style type names, and any `openclaw.*` URL) are never
// touched: none of them are spelled "OpenClaw" at a word boundary, so the
// case-sensitive \bOpenClaw\b pattern already leaves them alone.
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

/**
 * Returns true when `node` (a StringLiteral) sits in a structural position —
 * a module specifier (`import`/`export ... from`, `require(...)`, dynamic
 * `import(...)`, `import ... = require(...)`), an import attribute
 * (`with { type: "json" }`), a quoted object/interface/class property key, or
 * an enum member's name/value — rather than user-facing prose. These read as
 * ordinary string literals to the parser but are identifiers/paths/constants
 * in disguise (e.g. `import x from "../OpenClawKit/x.json"` or `enum E { A =
 * "OpenClawA" }`), so the brand rewrite must never touch them.
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
  if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
    if (ts.isImportCall(parent)) {
      return true;
    }
    if (ts.isIdentifier(parent.expression) && parent.expression.text === "require") {
      return true;
    }
  }
  if (
    typeof ts.isImportAttribute === "function" &&
    ts.isImportAttribute(parent) &&
    (parent.name === node || parent.value === node)
  ) {
    return true;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
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
 * regex denylist.
 */
function collectLiteralRanges(sourceFile) {
  const ranges = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node)) {
      if (!isStructuralStringLiteral(node)) {
        ranges.push([node.getStart(sourceFile), node.getEnd()]);
      }
      return;
    }
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail ||
      ts.isJsxText(node)
    ) {
      ranges.push([node.getStart(sourceFile), node.getEnd()]);
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
      ranges.push([comment.pos, comment.end]);
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
 * rather than code. Identifiers (`OpenClawConfig`), import/require/dynamic-
 * import specifiers, quoted property keys, and enum member names/values are
 * therefore never touched even when they spell "OpenClaw" at a word
 * boundary; see `isStructuralStringLiteral` for the exact exclusions.
 */
export function rewriteTypeScriptContent(content, relativePath) {
  const scriptKind = relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind,
  );
  const ranges = [...collectLiteralRanges(sourceFile), ...collectCommentRanges(sourceFile)].sort(
    (left, right) => left[0] - right[0],
  );

  let count = 0;
  let output = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start < cursor) {
      // Defensive: literal and comment ranges are structurally disjoint, but
      // never let an unexpected overlap corrupt output by double-emitting.
      continue;
    }
    output += content.slice(cursor, start);
    const result = countAndReplace(content.slice(start, end));
    output += result.text;
    count += result.count;
    cursor = end;
  }
  output += content.slice(cursor);
  return { content: output, count };
}

// Directories whose `.ts`/`.tsx` files are rewritten with the TypeScript-
// aware pass above rather than the plain-text pass: CLI help/wizard/doctor
// prose and the Control UI, per the spec's user-visible-surfaces list.
const TYPESCRIPT_AWARE_PREFIXES = ["src/cli/", "src/wizard/", "src/flows/", "ui/"];

function isTypeScriptAwareTarget(relativePath) {
  if (!/\.tsx?$/.test(relativePath)) {
    return false;
  }
  return TYPESCRIPT_AWARE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
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

/** Dispatches one file to the TypeScript-aware, prose, or JSON-field rewrite by its path/basename. */
export function rewriteFileContent(relativePath, content) {
  const basename = path.basename(relativePath);
  if (JSON_KEYS_BY_BASENAME.has(basename)) {
    return rewriteJsonManifestContent(content, basename);
  }
  if (isTypeScriptAwareTarget(relativePath)) {
    return rewriteTypeScriptContent(content, relativePath);
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

// CLI/wizard/doctor/Control-UI TypeScript sources, per the spec's
// user-visible-surfaces list (help header, onboarding, doctor prose, and the
// Control UI). Git's default (non-`:(glob)`) pathspec matching runs `*`
// through `fnmatch(3)` without `FNM_PATHNAME`, so a single `*` already
// crosses `/` — `src/cli/*.ts` matches `src/cli/program/help.ts` the same
// way `docs/*.md` above matches nested doc pages. `ui/config/*.ts` and
// `ui/vite*.config.ts` are deliberately excluded: build tooling, not
// shipped prose (confirmed clean — no literal "OpenClaw" in them).
const TYPESCRIPT_AWARE_GLOBS = [
  "src/cli/*.ts",
  "src/cli/*.tsx",
  "src/wizard/*.ts",
  "src/wizard/*.tsx",
  "src/flows/*.ts",
  "src/flows/*.tsx",
  "ui/src/*.ts",
  "ui/src/*.tsx",
];
const UI_SINGLE_FILE_TARGETS = ["ui/index.html", "ui/public/manifest.webmanifest"];

/**
 * Resolves the full set of files this rebrand pass covers: docs/README
 * prose, the two bundled-plugin manifest fields, the CLI/wizard/doctor/
 * Control-UI TypeScript sources, and the single already brand-module-backed
 * files. Restricting the manifest globs to exactly one path segment below
 * `extensions/` (git's `*` pathspec otherwise matches across `/`) keeps this
 * off nested qa-lab test-fixture manifests.
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
  for (const file of gitLsFiles(cwd, TYPESCRIPT_AWARE_GLOBS)) {
    if (isTypeScriptAwareTarget(file)) {
      files.add(file);
    }
  }
  for (const file of SINGLE_FILE_TARGETS) {
    files.add(file);
  }
  for (const file of UI_SINGLE_FILE_TARGETS) {
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
