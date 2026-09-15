import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectLocaleFiles,
  collectTargetFiles,
  parseRebrandArgv,
  rewriteFileContent,
  rewriteJsonManifestContent,
  rewriteLocaleContent,
  rewriteProseContent,
  rewriteTypeScriptContent,
  runRebrand,
  UPSTREAM_LICENCE_NOTICE_FILE,
} from "../../scripts/rebrand-apply.mjs";
import { createTempDirTracker } from "../helpers/temp-dir.ts";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../..");

const tempDirs = createTempDirTracker();
afterEach(() => {
  tempDirs.cleanup();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Builds a throwaway git repo containing the given files (indexed, uncommitted). */
function createFixtureRepo(files: Record<string, string>): string {
  const rootDir = tempDirs.make("brand-guard-");
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.email", "test@example.com");
  git(rootDir, "config", "user.name", "Test");
  for (const [file, content] of Object.entries(files)) {
    const filePath = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  git(rootDir, "add", "--", ...Object.keys(files));
  return rootDir;
}

describe("rewriteProseContent (Markdown)", () => {
  it("rewrites prose but leaves fenced code blocks and inline code spans untouched", () => {
    const content = [
      "# OpenClaw setup",
      "",
      "OpenClaw runs on your machine. See `OpenClawConfig` for the type.",
      "",
      "```ts",
      'const name = "OpenClaw"; // must not change inside a fence',
      "```",
      "",
      "Docs: https://docs.openclaw.ai/start/why-openclaw stays lowercase.",
    ].join("\n");

    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });

    expect(rewritten).toContain("# Vasudev setup");
    expect(rewritten).toContain("Vasudev runs on your machine.");
    // Inline code span is untouched even though it contains the literal name.
    expect(rewritten).toContain("`OpenClawConfig`");
    // Fenced code block body is fully untouched.
    expect(rewritten).toContain('const name = "OpenClaw"; // must not change inside a fence');
    // Lowercase URL/identifier text is untouched by the case-sensitive pattern.
    expect(rewritten).toContain("https://docs.openclaw.ai/start/why-openclaw");
    expect(count).toBe(2); // the heading and the "OpenClaw runs" sentence
  });

  it("is a no-op when the file has no word-boundary match", () => {
    const content = "openclaw.plugin.json, OPENCLAW_TOKEN, and OpenClawConfig are identifiers.\n";
    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });
    expect(rewritten).toBe(content);
    expect(count).toBe(0);
  });

  it("does not toggle fence state on an unrelated inline triple-backtick-like run", () => {
    // A line that both opens and later closes a fence on its own line pair
    // still balances; unmatched literal backticks inside prose stay literal.
    const content = ["before OpenClaw", "```", "inside OpenClaw", "```", "after OpenClaw"].join(
      "\n",
    );
    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });
    expect(rewritten).toBe(
      ["before Vasudev", "```", "inside OpenClaw", "```", "after Vasudev"].join("\n"),
    );
    expect(count).toBe(2);
  });
});

describe("rewriteProseContent (bundle/artifact names)", () => {
  it("never rewrites a shipped bundle name or a versioned release artifact filename", () => {
    // Native-app renaming is spec Phase 3, not this task: the files on disk
    // and GitHub release assets are still literally named this, so the docs
    // describing them must keep saying so.
    const content = [
      "Launch **OpenClaw.app** from Applications.",
      "Download `OpenClaw-Android.apk` from the latest OpenClaw release.",
      "Verify it against `OpenClaw-Android-SHA256SUMS.txt`.",
    ].join("\n");

    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });

    expect(rewritten).toContain("Launch **OpenClaw.app**");
    expect(rewritten).toContain("`OpenClaw-Android.apk`");
    expect(rewritten).toContain("`OpenClaw-Android-SHA256SUMS.txt`");
    expect(rewritten).toContain("the latest Vasudev release"); // surrounding prose still renames
    expect(count).toBe(1);
  });

  it("still rewrites a hyphenated adjective that is not a filename", () => {
    const content = "This is an OpenClaw-managed and OpenClaw-owned resource.\n";
    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });
    expect(rewritten).toBe("This is a Vasudev-managed and Vasudev-owned resource.\n");
    expect(count).toBe(2);
  });
});

describe("rewriteProseContent (generated blocks)", () => {
  it("never rewrites inside a clawtributors block, visible or hidden-comment variant", () => {
    const content = [
      "Thanks to all clawtributors:",
      "",
      "<!-- clawtributors:start -->",
      '<a href="https://github.com/stevebot"><img alt="Steve (OpenClaw)"></a>',
      "<!-- clawtributors:end -->",
      "<!-- clawtributors:hidden:start",
      "some-user (OpenClaw)",
      "clawtributors:hidden:end -->",
      "",
      "OpenClaw is developed in the open.",
    ].join("\n");

    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });

    expect(rewritten).toContain('alt="Steve (OpenClaw)"');
    expect(rewritten).toContain("some-user (OpenClaw)");
    expect(rewritten).toContain("Vasudev is developed in the open."); // prose outside the block still renames
    expect(count).toBe(1);
  });

  it("never rewrites inside a generic <!-- generated --> block", () => {
    const content = [
      "<!-- generated -->",
      "OpenClaw internal table row",
      "<!-- /generated -->",
      "OpenClaw prose outside the block.",
    ].join("\n");

    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });

    expect(rewritten).toContain("OpenClaw internal table row");
    expect(rewritten).toContain("Vasudev prose outside the block.");
    expect(count).toBe(1);
  });
});

describe("rewriteProseContent (link fragments)", () => {
  it("never rewrites a markdown link's #fragment, even one spelled in lowercase openclaw", () => {
    // A regression check: an earlier version of this script also tried to
    // sync `...#openclaw-...` link fragments to `...#vasudev-...` whenever a
    // heading elsewhere was renamed. That is unsound without resolving the
    // actual target file's current heading, and broke links whose target
    // legitimately keeps "openclaw" (a CLI command/config key/filename in
    // backticks, which this same rewrite correctly never touches) — see
    // `docs/gateway/security/index.md`'s `openclaw security audit` heading
    // and the `#openclaw-security-audit` links that point at it. The
    // fragment portion of a link is therefore never rewritten at all.
    const content = [
      "See [`openclaw security audit`](/gateway/security/running-the-audit#openclaw-security-audit).",
      "OpenClaw ships with conservative defaults.",
    ].join("\n");

    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });

    expect(rewritten).toContain("#openclaw-security-audit");
    expect(rewritten).toContain("Vasudev ships with conservative defaults.");
    expect(count).toBe(1); // only the prose sentence, not the link fragment
  });
});

describe("rewriteProseContent (plain .ts prose)", () => {
  it("rewrites every word-boundary match with no fence/code-span handling", () => {
    const content = '/** Publishes OpenClaw gateway Bonjour records. */\nconst x = "OpenClaw";\n';
    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: false });
    expect(rewritten).toBe(
      '/** Publishes Vasudev gateway Bonjour records. */\nconst x = "Vasudev";\n',
    );
    expect(count).toBe(2);
  });
});

describe("rewriteJsonManifestContent", () => {
  it("rewrites only the top-level description in package.json, not deps/urls/blurb-less fields", () => {
    const content = [
      "{",
      '  "name": "@openclaw/telegram",',
      '  "description": "OpenClaw Telegram channel plugin",',
      '  "repository": {',
      '    "type": "git",',
      '    "url": "https://github.com/openclaw/openclaw"',
      "  },",
      '  "dependencies": {',
      '    "openclaw": "workspace:*"',
      "  }",
      "}",
      "",
    ].join("\n");

    const { content: rewritten, count } = rewriteJsonManifestContent(content, "package.json");

    expect(count).toBe(1);
    expect(rewritten).toContain('"description": "Vasudev Telegram channel plugin"');
    expect(rewritten).toContain('"name": "@openclaw/telegram"');
    expect(rewritten).toContain('"url": "https://github.com/openclaw/openclaw"');
    expect(rewritten).toContain('"openclaw": "workspace:*"');
  });

  it("rewrites the nested openclaw.channel.blurb field in package.json", () => {
    const content = [
      "{",
      '  "openclaw": {',
      '    "channel": {',
      '      "blurb": "Connect OpenClaw agents to Buzz team rooms.",',
      '      "label": "Buzz"',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");

    const { content: rewritten, count } = rewriteJsonManifestContent(content, "package.json");

    expect(count).toBe(1);
    expect(rewritten).toContain('"blurb": "Connect Vasudev agents to Buzz team rooms."');
  });

  it("rewrites every prose-bearing field in openclaw.plugin.json", () => {
    const content = [
      "{",
      '  "id": "xai",',
      '  "name": "OpenClaw xAI",',
      '  "description": "OpenClaw xAI plugin.",',
      '  "configSchema": {',
      '    "properties": {',
      '      "model": {',
      '        "help": "OpenClaw does not currently support this model.",',
      '        "label": "OpenClaw Model",',
      '        "placeholder": "an OpenClaw model id",',
      '        "default": "OpenClaw Agent"',
      "      }",
      "    }",
      "  },",
      '  "setup": {',
      '    "choices": [',
      "      {",
      '        "choiceLabel": "OpenClaw managed server",',
      '        "choiceHint": "Connect to a server managed outside OpenClaw",',
      '        "groupLabel": "OpenClaw hosted",',
      '        "groupHint": "Servers OpenClaw starts for you",',
      '        "cliDescription": "Use the OpenClaw-managed server"',
      "      }",
      "    ]",
      "  },",
      '  "modelCatalog": {',
      '    "suppressions": [{ "reason": "OpenClaw does not support this model." }]',
      "  }",
      "}",
      "",
    ].join("\n");

    const { content: rewritten, count } = rewriteJsonManifestContent(
      content,
      "openclaw.plugin.json",
    );

    expect(count).toBe(11);
    expect(rewritten).toContain('"name": "Vasudev xAI"');
    expect(rewritten).toContain('"description": "Vasudev xAI plugin."');
    expect(rewritten).toContain('"help": "Vasudev does not currently support this model."');
    expect(rewritten).toContain('"label": "Vasudev Model"');
    expect(rewritten).toContain('"placeholder": "a Vasudev model id"');
    expect(rewritten).toContain('"default": "Vasudev Agent"');
    expect(rewritten).toContain('"choiceLabel": "Vasudev managed server"');
    expect(rewritten).toContain('"choiceHint": "Connect to a server managed outside Vasudev"');
    expect(rewritten).toContain('"groupLabel": "Vasudev hosted"');
    expect(rewritten).toContain('"groupHint": "Servers Vasudev starts for you"');
    expect(rewritten).toContain('"cliDescription": "Use the Vasudev-managed server"');
    // The plugin id is an identifier and never moves with the prose.
    expect(rewritten).toContain('"id": "xai"');
  });

  it("leaves identifier-shaped values under prose keys alone in openclaw.plugin.json", () => {
    const content = [
      "{",
      '  "id": "OpenClaw-Memory",',
      '  "name": "OpenClaw.app",',
      '  "description": "https://github.com/OpenClaw/OpenClaw",',
      '  "configSchema": {',
      '    "properties": {',
      '      "package": {',
      '        "default": "@openclaw/OpenClaw-plugin",',
      '        "label": "OPENCLAW_HOME/OpenClaw",',
      '        "help": "OpenClaw-Publication"',
      "      }",
      "    }",
      "  },",
      '  "machineKeys": {',
      '    "provider": "OpenClaw",',
      '    "cliFlag": "--OpenClaw",',
      '    "baseUrl": "https://api.example.com/OpenClaw"',
      "  }",
      "}",
      "",
    ].join("\n");

    const { content: rewritten, count } = rewriteJsonManifestContent(
      content,
      "openclaw.plugin.json",
    );

    expect(count).toBe(0);
    expect(rewritten).toBe(content);
  });

  it("rewrites only docs.json's name field, never its logo/favicon/colors", () => {
    const content = [
      "{",
      '  "$schema": "https://mintlify.com/docs.json",',
      '  "name": "OpenClaw",',
      '  "logo": {',
      '    "light": "/assets/pixel-lobster.svg"',
      "  },",
      '  "favicon": "/assets/pixel-lobster.svg",',
      '  "colors": {',
      '    "primary": "#D84A31"',
      "  }",
      "}",
      "",
    ].join("\n");

    const { content: rewritten, count } = rewriteJsonManifestContent(content, "docs.json");

    expect(count).toBe(1);
    expect(rewritten).toContain('"name": "Vasudev"');
    expect(rewritten).toContain('"light": "/assets/pixel-lobster.svg"');
    expect(rewritten).toContain('"favicon": "/assets/pixel-lobster.svg"');
    expect(rewritten).toContain('"primary": "#D84A31"');
  });
});

describe("collectTargetFiles", () => {
  it("resolves docs/README/manifest files and excludes nested fixture manifests", () => {
    const rootDir = createFixtureRepo({
      "README.md": "# OpenClaw\n",
      "docs/start/why-openclaw.md": "OpenClaw is great.\n",
      "extensions/telegram/package.json": '{"description": "OpenClaw Telegram channel plugin"}\n',
      "extensions/telegram/openclaw.plugin.json": '{"description": "OpenClaw Telegram plugin"}\n',
      "extensions/qa-lab/test-fixtures/some-plugin/openclaw.plugin.json": '{"id": "fixture"}\n',
      "extensions/qa-lab/test-fixtures/some-plugin/package.json": '{"name": "fixture"}\n',
      "src/channels/plugins/pairing-message.ts": 'export const X = "no brand text here";\n',
      "extensions/telegram/src/bot-message-context.session.ts": "export const Y = 1;\n",
      "extensions/bonjour/src/advertiser.ts": "export const Z = 1;\n",
      "docs/superpowers/specs/2026-09-14-vasudev-rebrand-design.md":
        'replace every "OpenClaw" with "Vasudev"\n',
    });

    const files = collectTargetFiles(rootDir);

    expect(files).toContain("README.md");
    expect(files).toContain("docs/docs.json");
    expect(files).toContain("docs/start/why-openclaw.md");
    expect(files).toContain("extensions/telegram/package.json");
    expect(files).toContain("extensions/telegram/openclaw.plugin.json");
    expect(files).not.toContain("extensions/qa-lab/test-fixtures/some-plugin/openclaw.plugin.json");
    expect(files).not.toContain("extensions/qa-lab/test-fixtures/some-plugin/package.json");
    // Self-referential planning docs that *discuss* "OpenClaw" as the string
    // being replaced: rewriting them turns `every "OpenClaw" -> "Vasudev"`
    // into nonsense (`every "Vasudev" -> "Vasudev"`), and they are absent
    // from docs.json's navigation (not part of the published docs site).
    expect(files).not.toContain("docs/superpowers/specs/2026-09-14-vasudev-rebrand-design.md");
  });

  it("resolves every in-scope source tree, keeps ui/** config and non-English locales out, and excludes test/fixture files from the apply", () => {
    const rootDir = createFixtureRepo({
      "README.md": "# OpenClaw\n",
      "src/channels/plugins/pairing-message.ts": 'export const X = "no brand text here";\n',
      "extensions/telegram/src/bot-message-context.session.ts": "export const Y = 1;\n",
      "extensions/bonjour/src/advertiser.ts": "export const Z = 1;\n",
      // Nested a directory level below each root to prove the recursive
      // glob (git's default `*` pathspec already crosses `/`) reaches them.
      "src/cli/program/help.ts": 'export const HELP = "OpenClaw --help";\n',
      "src/wizard/i18n/locales/en.ts": 'export const EN = "Welcome to OpenClaw";\n',
      "src/flows/doctor-health.ts": 'intro("OpenClaw doctor");\n',
      "src/gateway/server-methods/system-agent.ts": 'const m = "OpenClaw needs inference";\n',
      "extensions/whatsapp/src/pairing.ts": 'const m = "Pair with OpenClaw";\n',
      "packages/sdk/src/client.ts": 'const m = "OpenClaw Gateway does not support";\n',
      "ui/src/pages/about/view.ts": 'const m = "OpenClaw";\n',
      // Nested fixture packages under extensions/**: `extensions/*/src/*`
      // must match exactly one segment before `src/`.
      "extensions/qa-lab/test-fixtures/demo/src/index.ts": 'const m = "OpenClaw";\n',
      // Test/fixture files are excluded from the default apply -- see
      // TEST_OR_FIXTURE_RE in rebrand-apply.mjs -- because they assert
      // against real runtime output; they are rewritten only by an explicit
      // `--tests` run, after the matching production chunk's lane has proved
      // the real output.
      "src/cli/program/help.test.ts": 'export const HELP = "OpenClaw --help";\n',
      "src/cli/program/help.process.test.ts": 'export const HELP = "OpenClaw --help";\n',
      "src/cli/update-command.test-support.ts": 'export const X = "OpenClaw";\n',
      "src/wizard/setup.test-helpers.ts": 'export const X = "OpenClaw";\n',
      "src/agents/reply.triggers.cases.ts": 'expect(text).toContain("OpenClaw");\n',
      "src/test-utils/fake-gateway.ts": 'export const X = "OpenClaw";\n',
      "src/flows/__snapshots__/doctor-health.ts": "export const X = `OpenClaw`;\n",
      "src/cli/requirements-test-fixtures.ts": 'export const X = "OpenClaw";\n',
      // Service-identity file: excluded from both apply and check.
      "src/daemon/constants.ts": 'const TASK = "OpenClaw Gateway";\n',
      // The About page's upstream MIT notice: the one reviewed place the
      // upstream name may still appear in the product.
      "ui/src/pages/about/upstream-licence.ts": 'export const N = "Copyright (c) OpenClaw";\n',
      // Generated (non-English) locale catalogs: `--locales` only.
      "ui/src/i18n/locales/de.ts": 'export const de = { brand: "OpenClaw" };\n',
      "ui/src/i18n/locales/en.ts": 'export const en = { brand: "OpenClaw" };\n',
      "ui/src/i18n/locales/en-GB.ts": 'export const enGB = { brand: "OpenClaw" };\n',
      // ui/** outside ui/src is build tooling, not product copy.
      "ui/index.html": "<title>OpenClaw Control</title>\n",
      "ui/public/manifest.webmanifest": '{"name": "OpenClaw Control"}\n',
      "ui/vite.config.ts": 'export const base = "OpenClaw build config";\n',
      "ui/config/control-ui-locales.ts": 'export const X = "OpenClaw locales";\n',
    });

    const files = collectTargetFiles(rootDir);

    expect(files).toContain("src/cli/program/help.ts");
    expect(files).toContain("src/wizard/i18n/locales/en.ts");
    expect(files).toContain("src/flows/doctor-health.ts");
    expect(files).toContain("src/gateway/server-methods/system-agent.ts");
    expect(files).toContain("extensions/whatsapp/src/pairing.ts");
    expect(files).toContain("packages/sdk/src/client.ts");
    expect(files).toContain("ui/src/pages/about/view.ts");
    expect(files).toContain("ui/src/i18n/locales/en.ts");
    expect(files).toContain("ui/src/i18n/locales/en-GB.ts");
    expect(files).not.toContain("extensions/qa-lab/test-fixtures/demo/src/index.ts");
    expect(files).not.toContain("src/cli/program/help.test.ts");
    expect(files).not.toContain("src/cli/program/help.process.test.ts");
    expect(files).not.toContain("src/cli/update-command.test-support.ts");
    expect(files).not.toContain("src/wizard/setup.test-helpers.ts");
    expect(files).not.toContain("src/agents/reply.triggers.cases.ts");
    expect(files).not.toContain("src/test-utils/fake-gateway.ts");
    expect(files).not.toContain("src/flows/__snapshots__/doctor-health.ts");
    expect(files).not.toContain("src/cli/requirements-test-fixtures.ts");
    expect(files).not.toContain("src/daemon/constants.ts");
    expect(files).not.toContain(UPSTREAM_LICENCE_NOTICE_FILE);
    expect(files).not.toContain("ui/src/i18n/locales/de.ts");
    expect(files).not.toContain("ui/index.html");
    expect(files).not.toContain("ui/public/manifest.webmanifest");
    expect(files).not.toContain("ui/vite.config.ts");
    expect(files).not.toContain("ui/config/control-ui-locales.ts");

    // The guard scans test files too, so a settled expectation stays settled.
    const guarded = collectTargetFiles(rootDir, { includeTests: true });
    expect(guarded).toContain("src/cli/program/help.test.ts");
    expect(guarded).toContain("src/agents/reply.triggers.cases.ts");
    expect(guarded).not.toContain("src/daemon/constants.ts");
    expect(guarded).not.toContain(UPSTREAM_LICENCE_NOTICE_FILE);

    expect(collectLocaleFiles(rootDir)).toEqual(["ui/src/i18n/locales/de.ts"]);
  });

  it("resolves bundled-plugin and package sources that live at the plugin root, with the same one-segment filter", () => {
    const rootDir = createFixtureRepo({
      "README.md": "# OpenClaw\n",
      // Many bundled plugins keep their sources at the plugin root rather
      // than under `src/`, and every user-facing string in them is in scope
      // exactly as it is one directory down.
      "extensions/anthropic/auth.runtime.ts": 'const m = "OpenClaw needs a key";\n',
      "extensions/migrate-hermes/config-mcp.ts": 'const m = "OpenClaw config";\n',
      "extensions/telegram/pairing-prompt.tsx": "const m = <p>Pair with OpenClaw</p>;\n",
      "packages/sdk/client.ts": 'const m = "OpenClaw Gateway";\n',
      // One segment only: a nested fixture package's root sources are no
      // more in scope than its `src/` tree.
      "extensions/qa-lab/test-fixtures/demo/index.ts": 'const m = "OpenClaw";\n',
      // Test files at a plugin root follow the same rule as everywhere else:
      // out of the default apply, inside the guard's scan.
      "extensions/anthropic/auth.runtime.test.ts": 'expect(m).toBe("OpenClaw");\n',
    });

    const files = collectTargetFiles(rootDir);

    expect(files).toContain("extensions/anthropic/auth.runtime.ts");
    expect(files).toContain("extensions/migrate-hermes/config-mcp.ts");
    expect(files).toContain("extensions/telegram/pairing-prompt.tsx");
    expect(files).toContain("packages/sdk/client.ts");
    expect(files).not.toContain("extensions/qa-lab/test-fixtures/demo/index.ts");
    expect(files).not.toContain("extensions/anthropic/auth.runtime.test.ts");

    const guarded = collectTargetFiles(rootDir, { includeTests: true });
    expect(guarded).toContain("extensions/anthropic/auth.runtime.test.ts");
    expect(guarded).not.toContain("extensions/qa-lab/test-fixtures/demo/index.ts");
  });
});

describe("self-referential docs and the licence exemption", () => {
  it("keeps release notes, the rename history, the credits page, the dev persona templates, the licence notice and its guard out of the allowlist", () => {
    const rootDir = createFixtureRepo({
      "README.md": "# OpenClaw\n",
      "docs/docs.json": '{"name": "OpenClaw"}\n',
      "extensions/telegram/package.json": '{"description": "OpenClaw Telegram"}\n',
      "extensions/telegram/openclaw.plugin.json": "{}\n",
      "src/channels/plugins/pairing-message.ts": "export const X = 1;\n",
      "extensions/telegram/src/bot-message-context.session.ts": "export const Y = 1;\n",
      "extensions/bonjour/src/advertiser.ts": "export const Z = 1;\n",
      "docs/start/lore.md": "**Clawd -> Moltbot -> Vasudev.**\n",
      "docs/reference/credits.md": "- **Clawd** - the space lobster\n",
      "docs/reference/templates/SOUL.dev.md": "C-3PO: Clawd's 3rd Protocol Observer.\n",
      "docs/releases/2026.8.1/native-apps.md": "- Add a mood-aware Clawd mascot\n",
      "docs/start/getting-started.md": "OpenClaw runs on your machine.\n",
      "ui/src/pages/about/upstream-licence.ts": 'export const N = "Copyright (c) OpenClaw";\n',
      "ui/src/i18n/locales/brand.test.ts": 'expect(n).toContain("OpenClaw Foundation");\n',
    });

    const files = collectTargetFiles(rootDir, { includeTests: true });

    expect(files).toContain("docs/start/getting-started.md");
    expect(files).not.toContain("docs/start/lore.md");
    expect(files).not.toContain("docs/reference/credits.md");
    expect(files).not.toContain("docs/reference/templates/SOUL.dev.md");
    expect(files).not.toContain("docs/releases/2026.8.1/native-apps.md");
    expect(files).not.toContain(UPSTREAM_LICENCE_NOTICE_FILE);
    expect(files).not.toContain("ui/src/i18n/locales/brand.test.ts");
  });
});

describe("parseRebrandArgv", () => {
  it("parses --check, --tests, --locales, repeated --only, and bare file arguments", () => {
    expect(parseRebrandArgv(["--check"])).toMatchObject({ check: true, only: [] });
    expect(
      parseRebrandArgv(["--tests", "--only", "src/gateway", "--only=src/state"]),
    ).toMatchObject({ includeTests: true, only: ["src/gateway", "src/state"] });
    expect(parseRebrandArgv(["--locales"])).toMatchObject({ locales: true });
    expect(parseRebrandArgv(["README.md"])).toMatchObject({ files: ["README.md"] });
    expect(() => parseRebrandArgv(["--only"])).toThrow(/--only requires/u);
    expect(() => parseRebrandArgv(["--nope"])).toThrow(/unknown option/u);
  });
});

describe("--only chunked runs", () => {
  it("restricts the pass to files under the given path prefix", () => {
    const rootDir = createFixtureRepo({
      "README.md": "# OpenClaw\n",
      "docs/docs.json": '{"name": "OpenClaw"}\n',
      "extensions/telegram/package.json": '{"description": "OpenClaw Telegram"}\n',
      "extensions/telegram/openclaw.plugin.json": "{}\n",
      "src/channels/plugins/pairing-message.ts": "export const X = 1;\n",
      "extensions/telegram/src/bot-message-context.session.ts": "export const Y = 1;\n",
      "extensions/bonjour/src/advertiser.ts": "export const Z = 1;\n",
      "src/gateway/a.ts": 'const m = "OpenClaw gateway message";\n',
      "src/state/b.ts": 'const m = "OpenClaw state message";\n',
    });

    const applied = runRebrand({ cwd: rootDir, only: ["src/gateway"] });
    expect(applied.changes.map((change) => change.file)).toEqual(["src/gateway/a.ts"]);
    expect(fs.readFileSync(path.join(rootDir, "src/state/b.ts"), "utf8")).toContain("OpenClaw");
  });
});

describe("rewriteLocaleContent (--locales)", () => {
  it("swaps only the product name and leaves every other byte alone", () => {
    const content = [
      "export const de = {",
      '  brandName: "OpenClaw",',
      '  docsUrl: "https://docs.openclaw.ai/start",',
      '  hint: "Führe `openclaw doctor` aus, um OpenClaw zu reparieren.",',
      "} satisfies OpenClawCatalog;",
    ].join("\n");

    const { content: rewritten, count } = rewriteLocaleContent(content);

    expect(count).toBe(2);
    expect(rewritten).toContain('brandName: "Vasudev",');
    expect(rewritten).toContain("um Vasudev zu reparieren");
    // No command-alias rewrite, no identifier rewrite, no URL rewrite.
    expect(rewritten).toContain("`openclaw doctor`");
    expect(rewritten).toContain("https://docs.openclaw.ai/start");
    expect(rewritten).toContain("satisfies OpenClawCatalog;");
  });
});

describe("rewriteTypeScriptContent", () => {
  it("rewrites a string literal", () => {
    const content = 'const msg = "OpenClaw doctor found an issue";\n';
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "src/flows/doctor.ts");
    expect(rewritten).toBe('const msg = "Vasudev doctor found an issue";\n');
    expect(count).toBe(1);
  });

  it("does not rewrite an identifier/type name", () => {
    const content = "interface OpenClawConfig {\n  home: string;\n}\n";
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "src/cli/config.ts");
    expect(rewritten).toBe(content);
    expect(count).toBe(0);
  });

  it("does not rewrite an import path, even one spelling out the word", () => {
    const content =
      'import kit from "../../apps/shared/OpenClaw/Sources/OpenClaw/tool-display.json" with { type: "json" };\n';
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "ui/src/lib/tool.ts");
    expect(rewritten).toBe(content);
    expect(count).toBe(0);
  });

  it("rewrites a template literal", () => {
    const content = "const greeting = `Welcome to OpenClaw, ${name}!`;\n";
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "src/wizard/setup.ts");
    expect(rewritten).toBe("const greeting = `Welcome to Vasudev, ${name}!`;\n");
    expect(count).toBe(1);
  });

  it("rewrites a comment, including a JSDoc block comment after a template literal", () => {
    const content = [
      "const greeting = `Welcome to OpenClaw, ${name}!`;",
      "/** OpenClaw Lit base for shared components. */",
      "export const X = 1;",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "ui/src/base.ts");
    expect(rewritten).toContain("Welcome to Vasudev,");
    expect(rewritten).toContain("/** Vasudev Lit base for shared components. */");
    expect(count).toBe(2);
  });

  it("does not rewrite an OPENCLAW_HOME-style env var name", () => {
    const content =
      'const home = process.env.OPENCLAW_HOME;\nconst msg = "OPENCLAW_HOME is not set";\n';
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "src/cli/env.ts");
    expect(rewritten).toBe(content);
    expect(count).toBe(0);
  });

  it("does not rewrite a quoted object property key or an enum member's name/value", () => {
    const content = [
      'const obj = { "OpenClaw": 1 };',
      "enum Provider {",
      '  A = "OpenClaw",',
      "}",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "src/cli/enum.ts");
    expect(rewritten).toBe(content);
    expect(count).toBe(0);
  });

  it("rewrites a locale file's brandName string value while leaving its key, a docs URL, and a type name alone", () => {
    // The brief's fourth required fixture case: a locale-shaped file (the
    // real ui/src/i18n/locales/en.ts is not yet swept -- see
    // DEFERRED_ALLOWLIST_GLOBS -- but the TypeScript-aware rewrite mechanism
    // this exercises is the same one that will run over it once ui/** is
    // migrated).
    const content = [
      "import type { OpenClawConfig } from '../config.ts';",
      "",
      "export const en = {",
      '  brandName: "OpenClaw",',
      '  docsUrl: "https://docs.openclaw.ai/start/getting-started",',
      "} satisfies OpenClawConfig;",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "ui/src/i18n/locales/en.ts",
    );

    expect(rewritten).toContain('brandName: "Vasudev",');
    expect(rewritten).toContain('docsUrl: "https://docs.openclaw.ai/start/getting-started",');
    expect(rewritten).toContain("import type { OpenClawConfig }");
    expect(rewritten).toContain("} satisfies OpenClawConfig;");
    expect(count).toBe(1); // only the brandName string value
  });

  it("rewrites JSX text but leaves an identifier used as a JSX attribute value untouched", () => {
    // `.tsx` parsing: JsxText between tags is prose (rewritten); an
    // `{Identifier}` expression container attribute value is still just an
    // Identifier node, not a literal, so it is untouched the same way a
    // bare identifier is anywhere else in the file.
    const content = [
      "const OpenClawIcon = 1;",
      "function Example() {",
      "  return <div title={OpenClawIcon}>Welcome to OpenClaw</div>;",
      "}",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "ui/src/example.tsx");

    expect(rewritten).toContain("const OpenClawIcon = 1;");
    expect(rewritten).toContain("title={OpenClawIcon}");
    expect(rewritten).toContain(">Welcome to Vasudev</div>");
    expect(count).toBe(1); // only the JSX text
  });
});

describe("rewriteFileContent (test/fixture and cross-boundary exclusions)", () => {
  it("never rewrites a test, test-support, test-helpers, cases, test-utils, __snapshots__, or fixture file in a default apply", () => {
    const cases = [
      "src/cli/program/help.test.ts",
      "src/cli/program/help.process.test.ts",
      "src/cli/update-command.test-support.ts",
      "src/wizard/setup.test-helpers.ts",
      "extensions/matrix/src/onboarding.test-harness.ts",
      "src/agents/reply.triggers.cases.ts",
      "src/test-utils/fake-gateway.ts",
      "src/flows/__snapshots__/doctor-health.ts",
      "src/cli/requirements-test-fixtures.ts",
    ];
    for (const relativePath of cases) {
      const content = 'export const X = "OpenClaw";\n';
      const { content: rewritten, count } = rewriteFileContent(relativePath, content);
      expect(rewritten, relativePath).toBe(content);
      expect(count, relativePath).toBe(0);
    }
  });

  it("rewrites a test file only under an explicit --tests run", () => {
    const content = 'expect(out).toContain("OpenClaw doctor found an issue");\n';
    expect(rewriteFileContent("src/cli/doctor.test.ts", content).count).toBe(0);
    const forced = rewriteFileContent("src/cli/doctor.test.ts", content, { includeTests: true });
    expect(forced.count).toBe(1);
    expect(forced.content).toContain("Vasudev doctor found an issue");
  });

  it("never rewrites the OS service-identity files that name already-installed services", () => {
    // src/daemon/constants.ts's "OpenClaw Gateway" is the Windows scheduled
    // task name and systemd/launchd Description of services already
    // installed on operators' machines; install, uninstall, status and
    // update all look them up by that exact string. The systemd/schtasks
    // installers parse and re-emit the same label, so all of them move
    // together or none do.
    const cases = [
      "src/daemon/constants.ts",
      "src/daemon/systemd-install.ts",
      "src/daemon/systemd-unit.ts",
      "src/daemon/schtasks-install.ts",
      "src/daemon/inspect.ts",
    ];
    for (const relativePath of cases) {
      const content = 'const label = "OpenClaw Gateway";\n';
      const { content: rewritten, count } = rewriteFileContent(relativePath, content);
      expect(rewritten, relativePath).toBe(content);
      expect(count, relativePath).toBe(0);
    }
  });

  it("never rewrites a cited per-file literal that identifies this client to a third party", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // Reported to model providers as the calling app (OpenRouter X-Title,
      // X-BILLING-INVOKE-ORIGIN): providers key attribution and billing on it.
      ["src/agents/provider-attribution.ts", 'const P = "OpenClaw";\n'],
      // clientInfo.title in the Codex app-server initialize handshake.
      ["extensions/codex/src/app-server/client.ts", 'const t = { title: "OpenClaw" };\n'],
      // serviceName in Codex thread/start: Codex scopes credentials by it.
      [
        "extensions/codex/src/app-server/bounded-turn.ts",
        'const s = { serviceName: "OpenClaw" };\n',
      ],
      [
        "extensions/codex/src/app-server/thread-requests.ts",
        'const s = { serviceName: "OpenClaw" };\n',
      ],
      // Test input, not copy: it normalizes to the reserved system-agent id
      // `openclaw`, which is the lowercase internal namespace and does not move.
      ["src/system-agent/setup-apply.test.ts", 'const c = { id: "OpenClaw" };\n'],
      ["src/system-agent/operations.test.ts", 'const o = { agentId: "OpenClaw" };\n'],
    ];
    for (const [relativePath, content] of cases) {
      const { content: rewritten, count } = rewriteFileContent(relativePath, content);
      expect(rewritten, relativePath).toBe(content);
      expect(count, relativePath).toBe(0);
    }
  });

  it("never rewrites a reserved-agent-id input in the cases that prove it is refused", () => {
    // "OpenClaw" normalizes onto `openclaw`, the reserved system-agent id and
    // the lowercase internal namespace this rebrand does not move. Renaming the
    // input stops the case exercising the refusal at all.
    const content = [
      'for (const name of ["OpenClaw", "crestodian"]) {',
      '  await expect(createAgent({ name })).resolves.toMatchObject({ reason: "reserved-id" });',
      "}",
      'const why = "OpenClaw refuses the reserved id.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteFileContent(
      "src/agents/agent-create.test.ts",
      content,
      { includeTests: true },
    );
    expect(rewritten).toContain('["OpenClaw", "crestodian"]');
    expect(rewritten).toContain('"Vasudev refuses the reserved id."');
    expect(count).toBe(1);
  });

  it("never rewrites the pre-rename completion marker the installer still replaces", () => {
    // Profiles written by earlier installs carry this exact line. The installer
    // has to keep recognising it to replace that block instead of appending a
    // second one beside it.
    const content = [
      'const headers = ["# OpenClaw Completion", "# Vasudev Completion"] as const;',
      'const why = "OpenClaw writes one marked block per profile.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteFileContent(
      "src/cli/completion-runtime.ts",
      content,
    );
    expect(rewritten).toContain('"# OpenClaw Completion"');
    expect(rewritten).toContain('"Vasudev writes one marked block per profile."');
    expect(count).toBe(1);
  });

  it("renames a wordmark that follows an escape sequence, and keeps shielded tokens shielded", () => {
    // The script scans raw source text, so the character before the wordmark in
    // `"\\n\\nOpenClaw ..."` is the `n` of the escape and a plain `\\b` finds no
    // boundary. Production copy hidden that way stayed unmigrated and invisible
    // to the guard; the protected-token rules have to follow the same widening
    // or a shielded token in the same position would start being rewritten.
    const content = [
      String.raw`const note = "\n\nOpenClaw selected its Linux OOM-score wrapper";`,
      String.raw`const article = "see\nan OpenClaw host";`,
      String.raw`const trailer = "published\n\nOpenClaw-Publication: abc123\n";`,
      String.raw`const internal = "Tool failed\nOpenClaw runtime context (internal): keep";`,
    ].join("\n");
    const { content: rewritten, count } = rewriteFileContent("src/agents/note.ts", content);

    expect(rewritten).toContain(String.raw`"\n\nVasudev selected its Linux OOM-score wrapper"`);
    expect(rewritten).toContain(String.raw`"see\na Vasudev host"`);
    expect(rewritten).toContain(String.raw`"published\n\nOpenClaw-Publication: abc123\n"`);
    expect(rewritten).toContain(
      String.raw`"Tool failed\nOpenClaw runtime context (internal): keep"`,
    );
    expect(count).toBe(2);
  });

  it("renames a node-update remediation expectation now that its producer formats the command", () => {
    // `NODE_RUNNER_UPDATE_REQUIRED_ISSUE` routes both shown commands through
    // `formatCliCommand`, so the assertions that read the payload back follow
    // the displayed name instead of pinning the real binary.
    const content = [
      'expect(finding).toMatchObject({ message: "run openclaw update, then reconnect" });',
      'const why = "OpenClaw reports the node as outdated.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteFileContent(
      "src/gateway/worker-environments/device-placement-selector.test.ts",
      content,
      { includeTests: true },
    );
    expect(rewritten).toContain('"run vasudev update, then reconnect"');
    expect(rewritten).toContain('"Vasudev reports the node as outdated."');
    expect(count).toBe(2);
  });

  it("still rewrites ordinary prose in a file that has one excluded literal", () => {
    const content = [
      'const product = "OpenClaw";',
      'const note = "Documented app attribution headers. Verified in OpenClaw runtime wrapper.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteFileContent(
      "src/agents/provider-attribution.ts",
      content,
    );
    expect(rewritten).toContain('const product = "OpenClaw";');
    expect(rewritten).toContain("Verified in Vasudev runtime wrapper.");
    expect(count).toBe(1);
  });
});

describe("protected tokens (values that cross a boundary this rebrand does not own)", () => {
  it("never rewrites the OpenClaw/<version> User-Agent product token, but still renames prose that slashes two names", () => {
    const content = [
      "const ua = `teams.ts[apps]/${sdk} OpenClaw/${version}`;",
      '/** Format: "OpenClaw/<openclaw-version>" — example "OpenClaw/2026.3.22". */',
      "// Packaged OpenClaw/Bun hosts cannot interpret npm shims.",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "extensions/msteams/src/user-agent.ts",
    );
    expect(rewritten).toContain("OpenClaw/${version}");
    expect(rewritten).toContain('"OpenClaw/<openclaw-version>"');
    expect(rewritten).toContain('"OpenClaw/2026.3.22"');
    expect(rewritten).toContain("Packaged Vasudev/Bun hosts");
    expect(count).toBe(1);
  });

  it("never rewrites the capitalized upstream repository slug, in either half", () => {
    // `src/projects`'s registry normalizes a clone URL into a project key and
    // compares it; renaming only the trailing half leaves a slug that
    // identifies no repository.
    const content = [
      'const clone = "https://github.com/OpenClaw/OpenClaw.git";',
      'const key = "github.com/OpenClaw/OpenClaw";',
      'const note = "Clone OpenClaw before running it.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/projects/project-registry.test.ts",
    );
    expect(rewritten).toContain('"https://github.com/OpenClaw/OpenClaw.git"');
    expect(rewritten).toContain('"github.com/OpenClaw/OpenClaw"');
    expect(rewritten).toContain("Clone Vasudev before running it.");
    expect(count).toBe(1);
  });

  it("never rewrites the OpenClaw-Publication git commit trailer", () => {
    // Written into commits in the user's own repository and read back to
    // recognise an already-published commit; commits made by earlier builds
    // carry the old spelling forever.
    const content = [
      'const marker = "OpenClaw-Publication";',
      "const found = message.includes(`OpenClaw-Publication: ${requestId}`);",
      "// OpenClaw appends the trailer once the push settles.",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/gateway/github-publication-executor.ts",
    );
    expect(rewritten).toContain('const marker = "OpenClaw-Publication";');
    expect(rewritten).toContain("`OpenClaw-Publication: ${requestId}`");
    expect(rewritten).toContain("// Vasudev appends the trailer");
    expect(count).toBe(1);
  });

  it("never rewrites a hyphenated HTTP header name, but still renames the prose beside it", () => {
    // Header names are wire tokens: senders outside this tree (the CLI capture
    // path, paired nodes, the Control UI) already spell them this way.
    const content = [
      "const request = `POST /mcp HTTP/1.1\\r\\nX-OpenClaw-Cli-Capture-Key: ${key}\\r\\n`;",
      'const header = "X-OpenClaw-Session-Key";',
      'const why = "OpenClaw sets the capture key header.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/gateway/mcp-http.ts",
    );
    expect(rewritten).toContain("X-OpenClaw-Cli-Capture-Key:");
    expect(rewritten).toContain('"X-OpenClaw-Session-Key"');
    expect(rewritten).toContain('"Vasudev sets the capture key header."');
    expect(count).toBe(1);
  });

  it("never rewrites a header name named inside a sentence the reader is told to send", () => {
    // src/gateway/server/hooks-request-handler.ts refuses a query-string token
    // and names the header to use instead. The Gateway only ever reads
    // `x-openclaw-token`, so renaming the sentence would hand the reader a
    // header the server ignores.
    const content = [
      "const refusal =",
      '  "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).";',
      'const note = "OpenClaw rejects query-string tokens.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/gateway/server/hooks-request-handler.ts",
    );
    expect(rewritten).toContain("X-OpenClaw-Token header");
    expect(rewritten).toContain('"Vasudev rejects query-string tokens."');
    expect(count).toBe(1);
  });

  it("never rewrites a node client-identity literal, but still renames a hyphenated adjective", () => {
    // src/shared/node-match.ts classifies a paired node as the current app with
    // `clientId.toLowerCase().startsWith("openclaw-")`; the desktop, iOS and
    // Android clients announce those ids on the wire.
    const content = [
      'const nodes = ["clawdbot-macos", " OpenClaw-MacOS "];',
      'const ios = "OpenClaw-iOS";',
      'const why = "Rejects an OpenClaw-managed host that is not paired.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/shared/node-match.test.ts",
    );
    expect(rewritten).toContain('" OpenClaw-MacOS "');
    expect(rewritten).toContain('"OpenClaw-iOS"');
    expect(rewritten).toContain('"Rejects a Vasudev-managed host that is not paired."');
    expect(count).toBe(1);
  });

  it("never rewrites a dot-prefixed on-disk directory from the .openclaw-* family", () => {
    // The packaged install writes these beside a bundled plugin, and the
    // matchers are case-insensitive, so fixtures spell them in mixed case.
    const content = [
      'const stage = "Dist/Extensions/browser/.OpenClaw-Install-Stage/package.json";',
      'const wiki = "vault/.OpenClaw-Wiki/cache/agent-digest.json";',
      'const why = "Rejects an OpenClaw-managed stage directory.";',
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/infra/package-dist-inventory.test.ts",
    );
    expect(rewritten).toContain(".OpenClaw-Install-Stage/package.json");
    expect(rewritten).toContain(".OpenClaw-Wiki/cache");
    expect(rewritten).toContain('"Rejects a Vasudev-managed stage directory."');
    expect(count).toBe(1);
  });

  it("keeps the canonical Windows task label in the test that relaunches it", () => {
    // src/infra/windows-task-restart.test.ts runs an already-registered
    // scheduled task, so it pins the label src/daemon/constants.ts generates;
    // the same words elsewhere are ordinary product copy.
    const command =
      "expect(result.tried).toContain('schtasks /Run /TN \"OpenClaw Gateway (work)\"');";
    const prose = 'const note = "OpenClaw Gateway is running.";';
    const scoped = rewriteTypeScriptContent(
      [command, 'const note = "OpenClaw relaunches the scheduled task.";'].join("\n"),
      "src/infra/windows-task-restart.test.ts",
    );
    expect(scoped.content).toContain('/TN "OpenClaw Gateway (work)"');
    expect(scoped.content).toContain('"Vasudev relaunches the scheduled task."');
    expect(rewriteTypeScriptContent(prose, "src/infra/other.test.ts").content).toContain(
      '"Vasudev Gateway is running."',
    );
  });

  it("never rewrites a real repository or bundle path segment", () => {
    const content = [
      "// Mirrors apps/macos/Sources/OpenClaw/AppProfile.swift so both surfaces agree.",
      "// Apple-silicon entries (MIT; see apps/macos/Sources/OpenClaw/Resources/NOTICE.md).",
      "// OpenClaw resolves the profile before connecting.",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "src/config/paths.ts");
    expect(rewritten).toContain("apps/macos/Sources/OpenClaw/AppProfile.swift");
    expect(rewritten).toContain("Sources/OpenClaw/Resources/NOTICE.md");
    expect(rewritten).toContain("// Vasudev resolves the profile");
    expect(count).toBe(1);
  });

  it("never rewrites the persisted internal-runtime-context header", () => {
    // Older builds wrote this exact header into transcripts; the strippers
    // match it verbatim to remove leaked internal context from stored
    // sessions, so renaming the matcher is a privacy regression.
    const content = [
      'const LEGACY = "OpenClaw runtime context (internal):";',
      'const leaked = value.includes("OpenClaw runtime context (internal):");',
      "// OpenClaw protects runtime-generated prompt blocks.",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/agents/internal-runtime-context.ts",
    );
    expect(rewritten).toContain('"OpenClaw runtime context (internal):"');
    expect(rewritten).toContain("// Vasudev protects runtime-generated");
    expect(count).toBe(1);
  });
});

describe("regex literals", () => {
  it("rewrites the brand and a command inside a regex literal", () => {
    const content = [
      "expect(out).toMatch(/^OpenClaw \\d+\\./u);",
      'await expect(run()).rejects.toThrow(/rerun "openclaw doctor"/iu);',
      "const keep = /OpenClawConfig/u;",
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/commands/doctor.test.ts",
    );
    expect(rewritten).toContain("/^Vasudev \\d+\\./u");
    expect(rewritten).toContain('/rerun "vasudev doctor"/iu');
    // No word boundary after "OpenClaw", so the type name is still untouched.
    expect(rewritten).toContain("/OpenClawConfig/u");
    expect(count).toBe(2);
  });
});

describe("article agreement", () => {
  it('turns "an OpenClaw" into "a Vasudev" so the rename reads correctly', () => {
    const content = [
      'const hint = "Paste the API key value, not an OpenClaw onboarding command.";',
      'const title = "An OpenClaw node hosts sessions.";',
      'const kept = "This is an OpenClaw-managed resource.";',
    ].join("\n");
    const { content: rewritten } = rewriteTypeScriptContent(content, "src/commands/doctor-auth.ts");
    expect(rewritten).toContain("not a Vasudev onboarding command.");
    expect(rewritten).toContain('"A Vasudev node hosts sessions."');
    expect(rewritten).toContain("This is a Vasudev-managed resource.");
  });
});

describe("displayed argv binary token", () => {
  it("renames the bare binary element of a displayed argv but not a spawned one", () => {
    const content = [
      'const shown = formatCliArgs(["openclaw", "devices", "approve", id]);',
      'const run = spawnSync("openclaw", ["devices", "approve", id]);',
      'const other = pick(["openclaw", "vasudev"]);',
    ].join("\n");
    const { content: rewritten } = rewriteTypeScriptContent(
      content,
      "src/commands/doctor-device-pairing.ts",
    );
    expect(rewritten).toContain('formatCliArgs(["vasudev", "devices", "approve", id])');
    expect(rewritten).toContain('spawnSync("openclaw", ["devices", "approve", id])');
    expect(rewritten).toContain('pick(["openclaw", "vasudev"])');
  });

  it("rewrites a command whose subcommand sits behind root options", () => {
    const content = [
      'const hint = "Run `openclaw --profile staging gateway status --deep` on the host.";',
      'const container = "openclaw --container repair-test config validate now";',
      'const version = "openclaw --version";',
    ].join("\n");
    const { content: rewritten } = rewriteTypeScriptContent(content, "src/commands/doctor.ts");
    expect(rewritten).toContain(
      "Run `vasudev --profile staging gateway status --deep` on the host.",
    );
    // A literal that is *only* a command line stays a value (see the bare
    // command literal rule), root options included.
    expect(rewritten).toContain('"openclaw --container repair-test config validate now"');
    // No subcommand follows, so this is the real binary on PATH.
    expect(rewritten).toContain('"openclaw --version"');
  });
});

describe("mascot name (Clawd -> Vasu)", () => {
  it("rewrites the mascot in product copy and comments but never a lowercase identifier, URL or legacy name", () => {
    const content = [
      'const waveHello = "Wave hello to Clawd";',
      'const note = "Clawd\'s Third Protocol Observer";',
      "// No configured transports is a true empty state, so Clawd rests here.",
      'const invite = "https://discord.gg/clawd";',
      'const legacy = "clawdbot-gateway";',
      'const legacyName = "Clawdbot";',
      'const contributors = "clawdtributors";',
    ].join("\n");

    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "ui/src/i18n/locales/en.ts",
    );

    expect(rewritten).toContain('"Wave hello to Vasu"');
    expect(rewritten).toContain('"Vasu\'s Third Protocol Observer"');
    expect(rewritten).toContain("so Vasu rests here.");
    // Lowercase spellings are identifiers, service names and URLs.
    expect(rewritten).toContain("https://discord.gg/clawd");
    expect(rewritten).toContain('"clawdbot-gateway"');
    expect(rewritten).toContain('"Clawdbot"'); // no word boundary after "Clawd"
    expect(rewritten).toContain('"clawdtributors"');
    expect(count).toBe(3);
  });

  it("never rewrites a quoted voice-alias property key named Clawd", () => {
    // `voiceAliases: { Clawd: "VoiceAlias..." }` is operator config data keyed
    // by an agent's configured name, not product copy.
    const content = 'const voiceAliases = { Clawd: "VoiceAlias1234567890" };\n';
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "src/config/talk.ts");
    expect(rewritten).toBe(content);
    expect(count).toBe(0);
  });

  it("rewrites the mascot in Markdown prose but not inside a code span", () => {
    const content = "Clawd waves back. Run `clawd --help` and see `Clawdbot`.\n";
    const { content: rewritten, count } = rewriteProseContent(content, { isMarkdown: true });
    expect(rewritten).toContain("Vasu waves back.");
    expect(rewritten).toContain("`clawd --help`");
    expect(count).toBe(1);
  });
});

describe("structural literal exclusions", () => {
  it("never rewrites a path.join/path.resolve segment, but still rewrites a Promise.resolve message", () => {
    const content = [
      'const legacy = path.join(root, "OpenClaw", FILE);',
      'const nested = path.posix.join("OpenClaw", "cache");',
      'const promised = Promise.resolve("OpenClaw update failed");',
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(
      content,
      "src/commands/doctor/shared/legacy-oauth-sidecar.ts",
    );
    expect(rewritten).toContain('path.join(root, "OpenClaw", FILE)');
    expect(rewritten).toContain('path.posix.join("OpenClaw", "cache")');
    expect(rewritten).toContain('Promise.resolve("Vasudev update failed")');
    expect(count).toBe(1);
  });

  it("never rewrites a process-spawn argument or an HTTP header value", () => {
    const content = [
      'spawnSync("openclaw", ["doctor"]);',
      'execFileSync("openclaw gateway status", { shell: true });',
      'const headers = { "X-OpenRouter-Title": "OpenClaw", "MM-API-Source": "OpenClaw" };',
      'const hint = "Run `openclaw doctor --fix` to repair OpenClaw.";',
    ].join("\n");
    const { content: rewritten } = rewriteTypeScriptContent(content, "src/agents/sessions/sdk.ts");
    expect(rewritten).toContain('spawnSync("openclaw", ["doctor"])');
    expect(rewritten).toContain('execFileSync("openclaw gateway status"');
    expect(rewritten).toContain('"X-OpenRouter-Title": "OpenClaw"');
    expect(rewritten).toContain('"MM-API-Source": "OpenClaw"');
    expect(rewritten).toContain("Run `vasudev doctor --fix` to repair Vasudev.");
  });

  it("never rewrites a header value passed through headers.set/append, but still rewrites an ordinary map value", () => {
    const content = [
      'headers.set("X-OpenRouter-Title", "OpenClaw");',
      'init.headers.append("MM-API-Source", "OpenClaw");',
      'labels.set("newer-schema", "a newer OpenClaw build");',
    ].join("\n");
    const { content: rewritten } = rewriteTypeScriptContent(
      content,
      "extensions/openrouter/stream.ts",
    );
    expect(rewritten).toContain('headers.set("X-OpenRouter-Title", "OpenClaw")');
    expect(rewritten).toContain('init.headers.append("MM-API-Source", "OpenClaw")');
    expect(rewritten).toContain('labels.set("newer-schema", "a newer Vasudev build")');
  });
});

describe("displayed CLI alias rewrite", () => {
  it("rewrites a command example inside a human-facing string", () => {
    const content = [
      'const fixHint = "Run `openclaw doctor --fix` to repair it.";',
      'const start = `Stop it (${formatCliCommand("openclaw gateway stop")}) first.`;',
      'const dev = "pnpm openclaw plugins list";',
    ].join("\n");
    const { content: rewritten } = rewriteTypeScriptContent(content, "src/infra/ports-format.ts");
    expect(rewritten).toContain("Run `vasudev doctor --fix`");
    expect(rewritten).toContain('formatCliCommand("vasudev gateway stop")');
    expect(rewritten).toContain('"pnpm vasudev plugins list"');
  });

  it("never rewrites a literal that is a bare command line and nothing else", () => {
    // These are values, not prose: `Type.Literal("openclaw update")` is a
    // Gateway protocol schema literal the Control UI validates by exact
    // equality and external SDK clients pin, and
    // `generatedBy: "openclaw secrets configure"` is persisted provenance.
    const content = [
      'const schema = { updateCommand: Type.Literal("openclaw update") };',
      'const headless = "openclaw node restart";',
      'const provenance = { generatedBy: "openclaw secrets configure" };',
      'const flagged = "openclaw doctor --fix";',
      'const hint = "Run `openclaw doctor --fix` to repair it.";',
    ].join("\n");
    const { content: rewritten } = rewriteTypeScriptContent(
      content,
      "packages/gateway-protocol/src/schema/environments.ts",
    );
    expect(rewritten).toContain('Type.Literal("openclaw update")');
    expect(rewritten).toContain('const headless = "openclaw node restart"');
    expect(rewritten).toContain('generatedBy: "openclaw secrets configure"');
    expect(rewritten).toContain('const flagged = "openclaw doctor --fix"');
    // A command inside a sentence is prose and still renames.
    expect(rewritten).toContain("Run `vasudev doctor --fix` to repair it.");
  });

  it("never rewrites a comment, a real binary path, a package/config namespace, or a non-command word", () => {
    const content = [
      "// Run `openclaw doctor --fix` on the host before filing a bug.",
      'const unit = "ExecStart=/usr/bin/openclaw gateway run";',
      'const pkg = "@openclaw/plugin-sdk";',
      'const home = "~/.openclaw/openclaw.json";',
      'const prose = "openclaw runtime context is internal";',
      'const win = "C:\\\\Program Files\\\\openclaw gateway";',
    ].join("\n");
    const { content: rewritten, count } = rewriteTypeScriptContent(content, "src/cli/hints.ts");
    expect(rewritten).toContain("// Run `openclaw doctor --fix` on the host");
    expect(rewritten).toContain("ExecStart=/usr/bin/openclaw gateway run");
    expect(rewritten).toContain('"@openclaw/plugin-sdk"');
    expect(rewritten).toContain('"~/.openclaw/openclaw.json"');
    expect(rewritten).toContain('"openclaw runtime context is internal"');
    expect(rewritten).toContain("Program Files\\\\openclaw gateway");
    expect(count).toBe(0);
  });
});

describe("runRebrand end-to-end over a fixture repo", () => {
  it("check mode reports violations, apply mode fixes them, and a second apply is a no-op", () => {
    const rootDir = createFixtureRepo({
      "README.md": "# OpenClaw 🦞\n\nOpenClaw is great. See `OpenClawConfig` for details.\n",
      "docs/start/index.md": [
        "---",
        'title: "Why OpenClaw"',
        "---",
        "",
        "OpenClaw connects your chats.",
        "",
        "```bash",
        "openclaw doctor",
        "```",
        "",
        'See <a id="openclaw-performance" /> and https://docs.openclaw.ai/start.',
      ].join("\n"),
      "extensions/telegram/package.json":
        JSON.stringify(
          { name: "@openclaw/telegram", description: "OpenClaw Telegram channel plugin" },
          null,
          2,
        ) + "\n",
      "extensions/telegram/openclaw.plugin.json":
        JSON.stringify(
          { id: "telegram", description: "OpenClaw Telegram channel plugin." },
          null,
          2,
        ) + "\n",
      "src/channels/plugins/pairing-message.ts": 'export const X = "no brand text here";\n',
      "extensions/telegram/src/bot-message-context.session.ts": "export const Y = 1;\n",
      "extensions/bonjour/src/advertiser.ts": "/** OpenClaw Bonjour advertiser. */\n",
    });

    const checked = runRebrand({ cwd: rootDir, check: true });
    expect(checked.violations.map((v) => v.file).sort()).toEqual(
      [
        "README.md",
        "docs/start/index.md",
        "extensions/bonjour/src/advertiser.ts",
        "extensions/telegram/openclaw.plugin.json",
        "extensions/telegram/package.json",
      ].sort(),
    );

    const applied = runRebrand({ cwd: rootDir, check: false });
    expect(applied.changes.length).toBe(5);

    const reChecked = runRebrand({ cwd: rootDir, check: true });
    expect(reChecked.violations).toEqual([]);

    const readmeAfter = fs.readFileSync(path.join(rootDir, "README.md"), "utf8");
    expect(readmeAfter).toContain("# Vasudev 🦞");
    expect(readmeAfter).toContain("Vasudev is great.");
    expect(readmeAfter).toContain("`OpenClawConfig`"); // inline code untouched

    const docAfter = fs.readFileSync(path.join(rootDir, "docs/start/index.md"), "utf8");
    expect(docAfter).toContain('title: "Why Vasudev"');
    expect(docAfter).toContain("Vasudev connects your chats.");
    expect(docAfter).toContain("openclaw doctor"); // fenced code block untouched
    expect(docAfter).toContain('<a id="openclaw-performance" />'); // explicit anchor untouched
    expect(docAfter).toContain("https://docs.openclaw.ai/start"); // URL untouched

    const packageJsonAfter = JSON.parse(
      fs.readFileSync(path.join(rootDir, "extensions/telegram/package.json"), "utf8"),
    );
    expect(packageJsonAfter.name).toBe("@openclaw/telegram");
    expect(packageJsonAfter.description).toBe("Vasudev Telegram channel plugin");

    const manifestAfter = JSON.parse(
      fs.readFileSync(path.join(rootDir, "extensions/telegram/openclaw.plugin.json"), "utf8"),
    );
    expect(manifestAfter.id).toBe("telegram");
    expect(manifestAfter.description).toBe("Vasudev Telegram channel plugin.");
  });
});

describe("check-brand.mjs CLI", () => {
  it("exits 1 and prints offending files/lines when the allowlist still has literal OpenClaw", () => {
    const rootDir = createFixtureRepo({
      "README.md": "# OpenClaw\n",
      "extensions/telegram/package.json": '{"description": "OpenClaw Telegram channel plugin"}\n',
      "extensions/telegram/openclaw.plugin.json": "{}\n",
      "src/channels/plugins/pairing-message.ts": "export const X = 1;\n",
      "extensions/telegram/src/bot-message-context.session.ts": "export const Y = 1;\n",
      "extensions/bonjour/src/advertiser.ts": "export const Z = 1;\n",
    });
    const scriptPath = path.join(REPO_ROOT, "scripts/check-brand.mjs");

    let error: (Error & { status?: number; stdout?: string; stderr?: string }) | undefined;
    try {
      execFileSync(process.execPath, [scriptPath], { cwd: rootDir, encoding: "utf8" });
    } catch (caught) {
      error = caught as typeof error;
    }

    expect(error).toBeDefined();
    expect(error?.status).toBe(1);
    expect(error?.stderr ?? "").toContain("README.md");
    expect(error?.stderr ?? "").toContain("1: # OpenClaw");
  });

  it("exits 0 once `rebrand-apply.mjs` has rewritten the allowlist", () => {
    const rootDir = createFixtureRepo({
      "README.md": "# Vasudev\n",
      "extensions/telegram/package.json": '{"description": "Vasudev Telegram channel plugin"}\n',
      "extensions/telegram/openclaw.plugin.json": "{}\n",
      "src/channels/plugins/pairing-message.ts": "export const X = 1;\n",
      "extensions/telegram/src/bot-message-context.session.ts": "export const Y = 1;\n",
      "extensions/bonjour/src/advertiser.ts": "export const Z = 1;\n",
    });
    const scriptPath = path.join(REPO_ROOT, "scripts/check-brand.mjs");

    const stdout = execFileSync(process.execPath, [scriptPath], { cwd: rootDir, encoding: "utf8" });
    expect(stdout).toContain("clean");
  });
});
