import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("substitutes the desk name and git ref into runcmd", () => {
    const output = render();
    expect(output).toContain(`hostname: ${deskName}`);
    expect(output).toContain(`--hostname ${deskName}`);
    expect(output).toContain(`git -C /opt/openclaw checkout ${gitRef}`);
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
});
