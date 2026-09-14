#!/usr/bin/env node

// Rewrites the literal product name "OpenClaw" -> "Vasudev" across the
// Vasudev rebrand's user-visible prose allowlist: docs, README, docs.json's
// `name` field, the two bundled-plugin manifest fields that feed the Control
// UI channel picker, and the CLI help/wizard/doctor prose in `src/cli/**`,
// `src/wizard/**`, and `src/flows/**` (a TypeScript-aware pass — see
// `rewriteTypeScriptContent` below). `ui/**` is not enforced yet — see
// DEFERRED_ALLOWLIST_GLOBS.
// Internal identifiers (the
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

// Shipped bundle/installer/archive names. Native-app renaming is spec Phase
// 3 (not this task): the actual files on disk, GitHub release assets, and
// package manager listings are still literally named "OpenClaw.app" /
// "OpenClaw-<version>-amd64.deb" / etc., so docs describing "launch
// OpenClaw.app" or "download OpenClaw-Android.apk" must keep saying that --
// renaming only the prose would make the doc describe a file that does not
// exist. Matches a bare OpenClaw.<ext> bundle name (the extension whitelist
// below) or an OpenClaw-<anything>.<ext> artifact filename (any extension,
// since release assets vary: .apk, .deb, .AppImage, -SHA256SUMS.txt, ...).
// Deliberately requires a literal extension after the hyphenated form so a
// hyphenated *adjective* like "OpenClaw-managed" or "OpenClaw-owned" (never
// a filename) is not caught and still renames.
const BUNDLE_ARTIFACT_RE =
  /\bOpenClaw(?:\.(?:app|dmg|exe|msi|pkg|zip)|-[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9]+)\b/g;

function countAndReplace(text) {
  let shielded = text;
  const placeholders = [];
  shielded = shielded.replace(BUNDLE_ARTIFACT_RE, (match) => {
    const token = ` PROTECTED_ARTIFACT_${placeholders.length} `;
    placeholders.push(match);
    return token;
  });
  const matches = shielded.match(NAME_PATTERN);
  if (!matches) {
    return { text, count: 0 };
  }
  let rewritten = shielded.replace(NAME_PATTERN, NEW_NAME);
  placeholders.forEach((phrase, index) => {
    rewritten = rewritten.split(` PROTECTED_ARTIFACT_${index} `).join(phrase);
  });
  return { text: rewritten, count: matches.length };
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
 * everything else is prose and is rewritten. Non-Markdown files (the single
 * allowlisted `.ts` files) have no code-fence/code-span concept and are
 * rewritten line-for-line.
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
// prose, per the spec's user-visible-surfaces list. ui/** is not included
// yet — see DEFERRED_ALLOWLIST_GLOBS below.
const TYPESCRIPT_AWARE_PREFIXES = ["src/cli/", "src/wizard/", "src/flows/"];

// Test and fixture files are never touched by the automated apply, in
// either direction (never scanned by `brand:check`, never rewritten by
// `brand:apply`) — not even a fallback to the plain-text pass. A test
// asserts against real runtime output; a mechanical rewrite of its
// expectation cannot verify the call site it exercises was migrated too; it
// can only make the fixture say what the tool *wants* to be true, not what
// the app prints. Test-file prose is instead read off real test-failure
// output and adjusted by hand (see the report's per-test decision table),
// which is the only way to know whether the underlying call site is
// actually in scope (rename the expectation) or still owned by an
// unmigrated module (revert it, since the test pins real output). Matches
// `*.test.ts`/`*.test.tsx` (including compound suffixes like
// `*.process.test.ts`, since they still end in ".test.ts"),
// `*.test-support.ts`, `*.test-helpers.ts`, any `__snapshots__` directory,
// and any path segment/filename containing "fixture"
// (`requirements-test-fixtures.ts`, `update-cli/fixtures/*`, ...).
const TEST_OR_FIXTURE_RE =
  /(?:\.test(?:-support|-helpers)?\.tsx?$|(?:^|\/)__snapshots__(?:\/|$)|fixture)/i;

// Production (non-test) files under the enforced trees excluded outright —
// not because they carry unmigrated user-facing prose, but because their
// only "OpenClaw" occurrence is a *value comparison* against a string
// literal owned by an out-of-scope module: an internal discriminant, not
// display text. Rewriting only this side of the comparison silently changes
// behavior (the branch the equality check guards becomes unreachable) while
// looking like an ordinary, correct prose rename. An exact, reviewable file
// list — not a phrase shield — because each entry can be checked against
// its cited real occurrence and source; remove the entry once the owning
// module is migrated and the comparison can rename too.
const VALUE_COMPARISON_EXCLUDED_FILES = new Set([
  // Line ~20: `reason === "a newer OpenClaw build"` compares against
  // src/infra/startup-maintenance-required.ts's still-"OpenClaw" reason
  // constant to choose rollback-vs-doctor guidance.
  "src/cli/gateway-cli/startup-maintenance.ts",
]);

function isUnderTypeScriptAwarePrefix(relativePath) {
  return TYPESCRIPT_AWARE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function isTypeScriptAwareTarget(relativePath) {
  if (!/\.tsx?$/.test(relativePath)) {
    return false;
  }
  return (
    isUnderTypeScriptAwarePrefix(relativePath) &&
    !TEST_OR_FIXTURE_RE.test(relativePath) &&
    !VALUE_COMPARISON_EXCLUDED_FILES.has(relativePath)
  );
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

/** Dispatches one file to the TypeScript-aware, prose, or JSON-field rewrite by its path/basename. */
export function rewriteFileContent(relativePath, content) {
  const basename = path.basename(relativePath);
  if (JSON_KEYS_BY_BASENAME.has(basename)) {
    return rewriteJsonManifestContent(content, basename);
  }
  if (/\.tsx?$/.test(relativePath) && isUnderTypeScriptAwarePrefix(relativePath)) {
    // A test/fixture file, or a file on the value-comparison exclusion
    // list, under these three trees must never be touched by any pass,
    // including a fallback to the plain-text one below — see
    // TEST_OR_FIXTURE_RE and VALUE_COMPARISON_EXCLUDED_FILES.
    if (
      TEST_OR_FIXTURE_RE.test(relativePath) ||
      VALUE_COMPARISON_EXCLUDED_FILES.has(relativePath)
    ) {
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

// CLI/wizard/doctor TypeScript sources, per the spec's user-visible-surfaces
// list (help header, onboarding, doctor prose). Git's default (non-
// `:(glob)`) pathspec matching runs `*` through `fnmatch(3)` without
// `FNM_PATHNAME`, so a single `*` already crosses `/` — `src/cli/*.ts`
// matches `src/cli/program/help.ts` the same way `docs/*.md` above matches
// nested doc pages.
const TYPESCRIPT_AWARE_GLOBS = [
  "src/cli/*.ts",
  "src/cli/*.tsx",
  "src/wizard/*.ts",
  "src/wizard/*.tsx",
  "src/flows/*.ts",
  "src/flows/*.tsx",
];

// Documented, not yet enforced. Spec section 2 lists ui/** as an eventual
// guard input too, but a first pass over it (this task) found many of its
// ~150 affected files are test files and test helpers whose expectations
// were not re-verified against the actual Control UI Vitest suite (only
// docs/README/manifest and cli/wizard/flows prose were gated here) — and at
// least one file (ui/src/i18n/locales/en.ts's "Built on OpenClaw" upstream-
// attribution line, credited alongside its own dedicated brand-completeness
// test) needs a self-reference exemption before a blind sweep is safe, the
// same class of bug as DOCS_EXCLUDED_PREFIX_RE's docs/superpowers exclusion
// above. Migrating ui/** call sites and their test expectations together,
// then proving them against the Control UI suite, is a follow-up task; wire
// these globs into TYPESCRIPT_AWARE_GLOBS/collectTargetFiles once that is
// done rather than sweeping them from this script alone.
export const DEFERRED_ALLOWLIST_GLOBS = [
  "ui/src/**/*.ts",
  "ui/index.html",
  "ui/public/manifest.webmanifest",
];

/**
 * Resolves the full set of files this rebrand pass covers: docs/README
 * prose, docs.json's `name` field, the two bundled-plugin manifest fields,
 * the CLI/wizard/doctor/Control-UI TypeScript sources, and the single
 * already brand-module-backed files. Restricting the manifest globs to
 * exactly one path segment below `extensions/` (git's `*` pathspec otherwise
 * matches across `/`) keeps this off nested qa-lab test-fixture manifests.
 */
export function collectTargetFiles(cwd) {
  const files = new Set();
  for (const file of gitLsFiles(cwd, ["docs/*.md"])) {
    if (!DOCS_EXCLUDED_PREFIX_RE.test(file)) {
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
    if (isTypeScriptAwareTarget(file)) {
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
