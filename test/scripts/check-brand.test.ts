import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTargetFiles,
  rewriteJsonManifestContent,
  rewriteProseContent,
  rewriteTypeScriptContent,
  runRebrand,
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

  it("rewrites the description field in openclaw.plugin.json but not help/label/name text", () => {
    const content = [
      "{",
      '  "id": "xai",',
      '  "name": "OpenClaw xAI",',
      '  "description": "OpenClaw xAI plugin.",',
      '  "configSchema": {',
      '    "properties": {',
      '      "model": {',
      '        "help": "OpenClaw does not currently support this model.",',
      '        "label": "OpenClaw Model"',
      "      }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");

    const { content: rewritten, count } = rewriteJsonManifestContent(
      content,
      "openclaw.plugin.json",
    );

    expect(count).toBe(1);
    expect(rewritten).toContain('"description": "Vasudev xAI plugin."');
    // Out of this guard's scope for now: help/label/name fields untouched.
    expect(rewritten).toContain('"name": "OpenClaw xAI"');
    expect(rewritten).toContain('"help": "OpenClaw does not currently support this model."');
    expect(rewritten).toContain('"label": "OpenClaw Model"');
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

  it("resolves nested CLI/wizard/flows/Control-UI TypeScript sources and the ui single files", () => {
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
      "ui/src/lit/openclaw-element.ts": "/** OpenClaw Lit base. */\nexport const X = 1;\n",
      "ui/index.html": "<title>%PRODUCT_NAME% Control</title>\n",
      "ui/public/manifest.webmanifest": '{"name": "Vasudev Control"}\n',
      // Build tooling under ui/, not shipped prose: never enforced.
      "ui/vite.config.ts": 'export const base = "OpenClaw build config";\n',
      "ui/config/control-ui-locales.ts": 'export const X = "OpenClaw locales";\n',
    });

    const files = collectTargetFiles(rootDir);

    expect(files).toContain("src/cli/program/help.ts");
    expect(files).toContain("src/wizard/i18n/locales/en.ts");
    expect(files).toContain("src/flows/doctor-health.ts");
    expect(files).toContain("ui/src/lit/openclaw-element.ts");
    expect(files).toContain("ui/index.html");
    expect(files).toContain("ui/public/manifest.webmanifest");
    expect(files).not.toContain("ui/vite.config.ts");
    expect(files).not.toContain("ui/config/control-ui-locales.ts");
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
