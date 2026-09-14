import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = join(HERE, "render-cloud-init.mjs");

/** ALL_CAPS-only, matching the renderer's own placeholder syntax — deliberately does not match
 *  the lowercase `{{messages[0].id}}`-style mustache tokens that legitimately survive rendering
 *  inside the embedded hooks config (those are the Gateway's own runtime template language, not
 *  this renderer's placeholders). */
const UNRESOLVED_PLACEHOLDER_RE = /\{\{[A-Z][A-Z0-9_]*\}\}/;
const RESTRICTIVE_PERMISSIONS = new Set(["0600", "0640"]);

type WriteFileEntry = { path: string; permissions?: string; owner?: string; content: string };
type CloudInitDoc = {
  write_files: WriteFileEntry[];
  runcmd: unknown[];
  packages: string[];
  power_state: { mode: string };
};

describe("render-cloud-init.mjs", () => {
  let dir: string;
  let tsAuthKeyFile: string;
  let tgTokenFile: string;
  const tsAuthKeyValue = "tskey-auth-fixture0123456789";
  const tgTokenValue = "123456789:AAFixtureTelegramBotTokenValue";
  const ownerTarget = "987654321";
  const deskName = "desk-proof";
  const gitRef = "feat/hosted-desk";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "desk-render-test-"));
    tsAuthKeyFile = join(dir, "ts-authkey");
    tgTokenFile = join(dir, "tg-token");
    writeFileSync(tsAuthKeyFile, `${tsAuthKeyValue}\n`);
    writeFileSync(tgTokenFile, `${tgTokenValue}\n`);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function render(extraArgs: string[] = []): string {
    return execFileSync(
      process.execPath,
      [
        RENDER_SCRIPT,
        "--name",
        deskName,
        "--ts-authkey-file",
        tsAuthKeyFile,
        "--tg-token-file",
        tgTokenFile,
        "--owner-target",
        ownerTarget,
        "--git-ref",
        gitRef,
        ...extraArgs,
      ],
      { encoding: "utf8" },
    );
  }

  it("renders valid YAML with no unresolved placeholder and nothing but the document on stdout", () => {
    const output = render();
    expect(output).not.toMatch(UNRESOLVED_PLACEHOLDER_RE);
    expect(output).not.toContain("{{INCLUDE:");
    expect(output.trimStart().startsWith("#cloud-config")).toBe(true);

    const doc = parseYaml(output) as CloudInitDoc;
    expect(Array.isArray(doc.write_files)).toBe(true);
    expect(Array.isArray(doc.runcmd)).toBe(true);
    expect(doc.power_state.mode).toBe("reboot");
  });

  it("emits a 7-bit ASCII document, and refuses when a non-ASCII byte would reach cloud-init", () => {
    const output = render();
    expect(output).toMatch(/^[\x00-\x7F]*$/);

    // A secret file is single-line by contract but its bytes are opaque; a stray UTF-8 character
    // there must be refused rather than shipped (DigitalOcean mangles it and cloud-init then
    // applies an empty config).
    writeFileSync(tgTokenFile, "123456789:AAFixture\u2014Token\n");
    let stderr = "";
    let status = 0;
    try {
      execFileSync(
        process.execPath,
        [
          RENDER_SCRIPT,
          "--name",
          deskName,
          "--ts-authkey-file",
          tsAuthKeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          ownerTarget,
          "--git-ref",
          gitRef,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const e = error as { status: number; stderr: string; stdout: string };
      status = e.status;
      stderr = e.stderr;
      expect(e.stdout).toBe("");
    }
    expect(status).not.toBe(0);
    expect(stderr).toContain("non-ASCII character U+2014");
  });

  it("substitutes the desk name and git ref into runcmd", () => {
    const output = render();
    expect(output).toContain(`hostname: ${deskName}`);
    expect(output).toContain(`--hostname ${deskName}`);
    expect(output).toContain(`git -C /opt/openclaw fetch --depth 1 origin ${gitRef}`);
    expect(output).toContain("git -C /opt/openclaw checkout --detach FETCH_HEAD");
    expect(output).toContain("tailscale set --operator=openclaw");
    expect(output).not.toContain('tailscale up --authkey "$(cat /root/ts-authkey)" --ssh');
  });

  it("keeps every secret value confined to write_files entries with restrictive permissions", () => {
    const output = render();
    const doc = parseYaml(output) as CloudInitDoc;

    for (const secret of [tsAuthKeyValue, tgTokenValue]) {
      const carriers = doc.write_files.filter((entry) => entry.content.includes(secret));
      expect(carriers.length).toBeGreaterThan(0);
      for (const entry of carriers) {
        expect(RESTRICTIVE_PERMISSIONS.has(entry.permissions ?? "")).toBe(true);
      }
      // The secret must never appear anywhere outside a write_files content block — not in
      // runcmd, packages, or any other top-level section of the rendered document.
      const withoutWriteFiles = output.replace(
        /write_files:[\s\S]*?(?=\nruncmd:)/,
        "write_files: <redacted>",
      );
      expect(withoutWriteFiles).not.toContain(secret);
    }
  });

  it("generates a random Gateway token when none is supplied, confined to a restrictive write_files entry", () => {
    const doc = parseYaml(render()) as CloudInitDoc;
    const gatewayTokenEntry = doc.write_files.find(
      (entry) => entry.path === "/etc/openclaw/secrets/gateway-token",
    );
    expect(gatewayTokenEntry).toBeDefined();
    expect(RESTRICTIVE_PERMISSIONS.has(gatewayTokenEntry?.permissions ?? "")).toBe(true);
    expect((gatewayTokenEntry?.content ?? "").trim().length).toBeGreaterThanOrEqual(32);
  });

  it("uses a caller-supplied Gateway token file instead of generating one", () => {
    const gatewayTokenFile = join(dir, "gateway-token");
    const fixedToken = "fixed-gateway-token-fixture";
    writeFileSync(gatewayTokenFile, `${fixedToken}\n`);

    const doc = parseYaml(render(["--gateway-token-file", gatewayTokenFile])) as CloudInitDoc;
    const gatewayTokenEntry = doc.write_files.find(
      (entry) => entry.path === "/etc/openclaw/secrets/gateway-token",
    );
    expect(gatewayTokenEntry?.content.trim()).toBe(fixedToken);
  });

  it("embeds a valid openclaw.json referencing secrets by file SecretRef, never inline", () => {
    const doc = parseYaml(render()) as CloudInitDoc;
    const configEntry = doc.write_files.find(
      (entry) => entry.path === "/home/openclaw/.openclaw/openclaw.json",
    );
    expect(configEntry).toBeDefined();
    expect(configEntry?.permissions).toBe("0600");
    expect(configEntry?.owner).toBe("openclaw:openclaw");

    const config = JSON.parse(configEntry?.content ?? "");
    expect(config.channels.telegram.botToken).toEqual({
      source: "file",
      provider: "telegram-bot-token-file",
      id: "value",
    });
    expect(config.channels.telegram.botToken).not.toBe(tgTokenValue);
    expect(config.gateway.auth.token).toEqual({
      source: "file",
      provider: "gateway-token-file",
      id: "value",
    });
    expect(config.gateway.tailscale.mode).toBe("serve");
    expect(config.browser.ssrfPolicy.allowedHostnames).toEqual(["127.0.0.1"]);
    expect(config.agents.ownership).toBe("explicit");
    expect(config.agents.entries["duties-mail"]).toBeDefined();
    expect(config.bindings).toContainEqual(
      expect.objectContaining({
        agentId: "krishna",
        match: { channel: "telegram", accountId: "*" },
      }),
    );
    expect(config.plugins.entries.duties.enabled).toBe(true);
    expect(config.plugins.entries.telegram.enabled).toBe(true);
    expect(config.hooks.defaultSessionKey).toBe("hook:gmail:ingress");
    expect(config.channels.telegram.allowFrom).toEqual([ownerTarget]);
    // The runtime hook-templating placeholder must survive rendering untouched — it belongs to
    // the Gateway's own mustache-style hook template language, not this renderer.
    expect(config.hooks.mappings[0].sessionKey).toBe("hook:gmail:{{messages[0].id}}");
  });

  it("embeds the exact systemd unit and Chromium policy file contents", () => {
    const doc = parseYaml(render()) as CloudInitDoc;
    const gatewayUnit = doc.write_files.find(
      (entry) => entry.path === "/etc/systemd/system/openclaw-gateway.service",
    );
    expect(gatewayUnit?.content).toContain(
      "ExecStart=/usr/bin/node /opt/openclaw/openclaw.mjs gateway run",
    );
    expect(gatewayUnit?.content).toContain("KillMode=mixed");

    const policyEntries = doc.write_files.filter((entry) => entry.path.endsWith("desk.json"));
    expect(policyEntries).toHaveLength(2);
    for (const entry of policyEntries) {
      const policy = JSON.parse(entry.content);
      expect(policy.URLBlocklist).toEqual(["chrome://*", "file://*"]);
      expect(policy.PasswordManagerEnabled).toBe(false);
    }
  });

  it("never writes deploy/desk/desk-health.sh via write_files — it ships in the git-cloned tree", () => {
    const doc = parseYaml(render()) as CloudInitDoc;
    const paths = doc.write_files.map((entry) => entry.path);
    expect(paths).not.toContain("/opt/openclaw/deploy/desk/desk-health.sh");
    expect(String(doc.runcmd)).toContain("chmod +x /opt/openclaw/deploy/desk/desk-health.sh");
  });

  it("refuses to render when a required argument is missing, printing nothing to stdout", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          RENDER_SCRIPT,
          "--ts-authkey-file",
          tsAuthKeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          ownerTarget,
          "--git-ref",
          gitRef,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toThrowError(/Command failed/);
  });

  it("refuses a --name containing shell/YAML-unsafe characters", () => {
    expect(() => render(["--name", "desk$(whoami)"])).toThrowError(/Command failed/);
    try {
      render(["--name", "desk;rm -rf /"]);
      expect.unreachable("render should have thrown for an unsafe --name");
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? "")).toMatch(/--name/);
    }
  });

  it("refuses a --git-ref containing shell-unsafe characters", () => {
    expect(() => render(["--git-ref", "main; rm -rf /"])).toThrowError(/Command failed/);
    try {
      render(["--git-ref", "$(whoami)"]);
      expect.unreachable("render should have thrown for an unsafe --git-ref");
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? "")).toMatch(/--git-ref/);
    }
  });

  it("refuses a --git-ref that starts with a dash, so it can never be parsed as a git option", () => {
    // `--git-ref=<value>` (rather than two argv entries) reaches the renderer's own validation
    // even for a value node:util's parseArgs would otherwise treat as an ambiguous option.
    try {
      execFileSync(
        process.execPath,
        [
          RENDER_SCRIPT,
          "--name",
          deskName,
          "--ts-authkey-file",
          tsAuthKeyFile,
          "--tg-token-file",
          tgTokenFile,
          "--owner-target",
          ownerTarget,
          "--git-ref=--upload-pack=evil",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      expect.unreachable("render should have thrown for a --git-ref starting with '-'");
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? "")).toMatch(
        /--git-ref.*must not start with/,
      );
    }
  });

  it("keeps the full pnpm packageManager string, including the sha512 integrity suffix, in corepack prepare", () => {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8")) as {
      packageManager: string;
    };
    const output = render();
    expect(pkg.packageManager).toMatch(/^pnpm@\d.*\+sha512\./);
    expect(output).toContain(`corepack prepare ${pkg.packageManager} --activate`);
  });
});
