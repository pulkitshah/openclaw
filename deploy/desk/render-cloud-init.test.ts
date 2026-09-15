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

  it("clones the operator's own fork, not a name hardcoded in the template, and lets --repo-url or DESK_FORK_REPO_URL override the default", () => {
    const defaultOutput = render();
    // No literal person/account name baked into the template: the default is read from this
    // checkout's own `origin` remote at render time.
    expect(defaultOutput).toMatch(
      /git clone --depth 1 --no-checkout https:\/\/\S+ \/opt\/openclaw/,
    );

    const flagOutput = render(["--repo-url", "https://github.com/example-org/example-fork"]);
    expect(flagOutput).toContain(
      "git clone --depth 1 --no-checkout https://github.com/example-org/example-fork /opt/openclaw",
    );

    const envOutput = execFileSync(
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
      {
        encoding: "utf8",
        env: { ...process.env, DESK_FORK_REPO_URL: "https://example.com/an-org/a-repo" },
      },
    );
    expect(envOutput).toContain(
      "git clone --depth 1 --no-checkout https://example.com/an-org/a-repo /opt/openclaw",
    );
  });

  it("refuses a --repo-url that is not a plain https:// host/owner/repo URL", () => {
    try {
      render(["--repo-url", "https://github.com/owner/repo; rm -rf /"]);
      expect.unreachable("render should have thrown for an unsafe --repo-url");
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? "")).toMatch(/fork repo URL/);
    }
    try {
      render(["--repo-url", "git@github.com:owner/repo.git"]);
      expect.unreachable("render should have thrown for a non-https --repo-url");
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? "")).toMatch(/fork repo URL/);
    }
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

  it("configures a persistent background Funnel on 8443 for the Gmail webhook after joining the tailnet, and keeps the watcher's own tailscale mode off", () => {
    const output = render();
    const tailscaleUpIndex = output.indexOf('tailscale up --authkey "$(cat /root/ts-authkey)"');
    const operatorIndex = output.indexOf("tailscale set --operator=openclaw");
    const funnelCommand =
      "tailscale funnel --bg --https=8443 --set-path=/gmail-pubsub http://127.0.0.1:8788";
    const funnelIndex = output.indexOf(funnelCommand);
    expect(tailscaleUpIndex).toBeGreaterThan(-1);
    expect(operatorIndex).toBeGreaterThan(tailscaleUpIndex);
    expect(funnelIndex).toBeGreaterThan(operatorIndex);

    // The Gateway's own foreground Serve claim on 443 (gateway.tailscale.mode "serve") is
    // untouched — only a second, different port carries the public webhook.
    expect(output).toContain('"mode": "serve"');

    const doc = parseYaml(output) as CloudInitDoc;
    const configEntry = doc.write_files.find(
      (entry) => entry.path === "/home/openclaw/.openclaw/openclaw.json",
    );
    const config = JSON.parse(configEntry?.content ?? "");
    expect(config.hooks.gmail).toEqual({
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "off" },
    });
  });

  it("--preflight renders gateway.tailscale.mode off and skips the tailscale runcmd lines, leaving the default render untouched", () => {
    const preflightOutput = render(["--preflight"]);
    const preflightDoc = parseYaml(preflightOutput) as CloudInitDoc;
    const preflightConfigEntry = preflightDoc.write_files.find(
      (entry) => entry.path === "/home/openclaw/.openclaw/openclaw.json",
    );
    const preflightConfig = JSON.parse(preflightConfigEntry?.content ?? "");
    expect(preflightConfig.gateway.tailscale.mode).toBe("off");
    // hooks.gmail.tailscale.mode is already "off" regardless (a desk's own runtime Tailscale
    // claiming never runs for Gmail — the persistent background Funnel handles it instead).
    expect(preflightConfig.hooks.gmail.tailscale.mode).toBe("off");
    expect(preflightOutput).not.toContain("tailscale up --authkey");
    expect(preflightOutput).not.toContain("tailscale set --operator=openclaw");
    expect(preflightOutput).not.toContain("tailscale funnel --bg");
    const skippedCount = preflightOutput.split("# preflight: tailscale skipped").length - 1;
    expect(skippedCount).toBe(3);

    // The default (non-preflight) render is unaffected by --preflight existing as an option.
    const defaultOutput = render();
    const defaultDoc = parseYaml(defaultOutput) as CloudInitDoc;
    const defaultConfigEntry = defaultDoc.write_files.find(
      (entry) => entry.path === "/home/openclaw/.openclaw/openclaw.json",
    );
    const defaultConfig = JSON.parse(defaultConfigEntry?.content ?? "");
    expect(defaultConfig.gateway.tailscale.mode).toBe("serve");
    expect(defaultOutput).toContain("tailscale set --operator=openclaw");
    expect(defaultOutput).toContain("tailscale funnel --bg --https=8443");
    expect(defaultOutput).not.toContain("# preflight: tailscale skipped");
  });

  it("restores Chromium's own sandbox via a sysctl file and applies it before Chromium is ever installed", () => {
    const output = render();
    const doc = parseYaml(output) as CloudInitDoc;
    const sysctlEntry = doc.write_files.find(
      (entry) => entry.path === "/etc/sysctl.d/60-openclaw-desk-chromium.conf",
    );
    expect(sysctlEntry).toBeDefined();
    expect(sysctlEntry?.content).toContain("kernel.apparmor_restrict_unprivileged_userns = 0");
    expect(sysctlEntry?.permissions).toBe("0644");

    const applyIndex = output.indexOf("sysctl --system");
    const chromiumInstallIndex = output.indexOf("playwright install-deps chromium");
    expect(applyIndex).toBeGreaterThan(-1);
    expect(chromiumInstallIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(chromiumInstallIndex);
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

  it("mints the hooks bearer into a root-only EnvironmentFile and references it from openclaw.json", () => {
    const output = render();
    const doc = parseYaml(output) as CloudInitDoc;
    const hooksEntry = doc.write_files.find(
      (entry) => entry.path === "/etc/openclaw/secrets/hooks-token.env",
    );
    expect(hooksEntry?.permissions).toBe("0600");
    // root:root, not openclaw:openclaw: systemd reads it before dropping to the service user,
    // so the uid the desk exposes to untrusted inbound mail never gets a readable copy.
    expect(hooksEntry?.owner).toBe("root:root");
    const minted = (hooksEntry?.content ?? "").trim().replace(/^HOOKS_TOKEN=/u, "");
    expect(minted.length).toBeGreaterThanOrEqual(32);

    const configEntry = doc.write_files.find(
      (entry) => entry.path === "/home/openclaw/.openclaw/openclaw.json",
    );
    const config = JSON.parse(configEntry?.content ?? "");
    // hooks.token rejects SecretRef objects, so the config carries the env reference the
    // Gateway resolves at load instead of the value itself.
    expect(config.hooks.token).toBe("${HOOKS_TOKEN}");
    expect(configEntry?.content).not.toContain(minted);

    const gatewayUnit = doc.write_files.find(
      (entry) => entry.path === "/etc/systemd/system/openclaw-gateway.service",
    );
    expect(gatewayUnit?.content).toContain(
      "EnvironmentFile=-/etc/openclaw/secrets/hooks-token.env",
    );
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
    // A fresh desk must be able to ANSWER after `claude auth login` alone: the anthropic plugin
    // supplies the models and every anthropic model id routes to the claude-cli runtime (the
    // owner's subscription), so no second `openclaw models auth login` step is needed. Without
    // this, a desk accepted the Claude login and still replied "Not logged in - please run
    // /login" with no documented step to reach for.
    expect(config.plugins.entries.anthropic.enabled).toBe(true);
    const models: Record<string, { agentRuntime?: { id?: string } }> =
      config.agents.defaults.models;
    expect(Object.keys(models).length).toBeGreaterThan(0);
    for (const [modelId, entry] of Object.entries(models)) {
      expect(modelId.startsWith("anthropic/")).toBe(true);
      expect(entry.agentRuntime?.id).toBe("claude-cli");
    }
    expect(models["anthropic/claude-opus-5"]?.agentRuntime?.id).toBe("claude-cli");
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

  it("never extracts a root-owned tarball straight into /tmp", () => {
    // A release tarball's own `./` entry carries owner/mode; extracting one into /tmp as root
    // applies that entry to /tmp itself and resets it from 1777 root:root to whatever the
    // archive's top-level entry says (observed 2026-09-14: gogcli's tarball reset /tmp to
    // 0755 501:staff and silently broke the browser plugin's mkdtemp, claude's own tmpdir, and
    // plugin cleanup). Every extraction must instead cd into a private `mktemp -d`.
    const output = render();
    expect(output).not.toMatch(/tar\s+[^\n]*-C\s*\/tmp\b/);
    expect(output).not.toMatch(/cd\s+\/tmp\b/);
    expect(output).toContain('workdir="$(mktemp -d)"');
    expect(output).toContain('cd "$workdir"');
    // The workdir is cleaned up on a failure partway through too, not only once every step of
    // the install has already succeeded.
    expect(output).toContain('|| { rm -rf "$workdir"');
  });

  it("never writes deploy/desk/desk-health.sh via write_files — it ships in the git-cloned tree", () => {
    const doc = parseYaml(render()) as CloudInitDoc;
    const paths = doc.write_files.map((entry) => entry.path);
    expect(paths).not.toContain("/opt/openclaw/deploy/desk/desk-health.sh");
    expect(String(doc.runcmd)).toContain("chmod +x /opt/openclaw/deploy/desk/desk-health.sh");
  });

  it("generates the credential keyfile only when one is not already on the disk", () => {
    const doc = parseYaml(render()) as CloudInitDoc;
    const runcmd = doc.runcmd.map((item) => (Array.isArray(item) ? item.join(" ") : String(item)));
    // A desk created with `--image <snapshot-id>` gets a new instance id, so cloud-init re-runs
    // over a disk that already carries the previous desk's encrypted credential store. An
    // unconditional keyfile there orphans that store permanently ("corrupt or was written with
    // another keyfile") — so the write is guarded, while chown/chmod stay unconditional.
    expect(runcmd).toContain(
      "test -f /etc/openclaw/keyfile || head -c 32 /dev/urandom > /etc/openclaw/keyfile",
    );
    expect(runcmd).not.toContain("head -c 32 /dev/urandom > /etc/openclaw/keyfile");
    expect(runcmd).toContain("chown root:openclaw /etc/openclaw/keyfile");
    expect(runcmd).toContain("chmod 640 /etc/openclaw/keyfile");
  });

  it("blocks the metadata service for non-root users, enabling the guard only after provisioning", () => {
    const output = render();
    const doc = parseYaml(output) as CloudInitDoc;
    const guard = doc.write_files.find(
      (entry) => entry.path === "/etc/systemd/system/desk-metadata-guard.service",
    );
    // DigitalOcean keeps this droplet's user-data — which carried the Tailscale auth key, the bot
    // token, the Gateway token and the hooks token — readable, unauthenticated, from the
    // link-local metadata service for the droplet's life, to any local process including the
    // service user that runs untrusted-mail-driven Duties.
    expect(guard?.content).toContain("iptables -I OUTPUT -d 169.254.169.254");
    expect(guard?.content).toContain("-m owner ! --uid-owner 0 -j REJECT");
    expect(guard?.content).toContain("Type=oneshot");
    expect(guard?.content).toContain("WantedBy=multi-user.target");
    // ip6tables is best effort (a leading "-" on the ExecStart): the metadata service is IPv4
    // link-local, and an image without the module must not leave the unit failed.
    expect(guard?.content).toContain('ExecStart=-/bin/sh -c "ip6tables');

    const runcmd = doc.runcmd.map((item) => (Array.isArray(item) ? item.join(" ") : String(item)));
    const guardIndex = runcmd.findIndex((item) =>
      item.includes("systemctl enable --now desk-metadata-guard.service"),
    );
    expect(guardIndex).toBeGreaterThan(-1);
    // Enabled LAST: provisioning itself (cloud-init, DigitalOcean's own agents) may need the
    // metadata service, and the Gateway must already be enabled by the time egress is closed.
    expect(guardIndex).toBe(runcmd.length - 1);
    expect(
      runcmd.findIndex((item) => item.includes("systemctl enable --now openclaw-gateway.service")),
    ).toBeLessThan(guardIndex);
  });

  it("marks provisioning failed rather than exiting when the Claude CLI install fails", () => {
    const output = render();
    // `runcmd` has no `set -e`, so an unguarded failure here left a desk whose agents can never
    // answer with nothing to show for it; an `exit` would be worse still (it skips every later
    // item, including the keyfile and unit enablement).
    expect(output).toContain("desk: claude-code install FAILED");
    expect(output).toContain("touch /var/lib/openclaw/provision-failed");
    expect(output).not.toMatch(/^\s*- claude --version\s*$/m);
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

  describe("--profile client", () => {
    /** A client desk needs neither the bot token nor the owner target, so this helper passes
     *  exactly what the profile requires — anything more would hide that they are optional. */
    function renderClient(extraArgs: string[] = []): string {
      return execFileSync(
        process.execPath,
        [
          RENDER_SCRIPT,
          "--profile",
          "client",
          "--name",
          deskName,
          "--ts-authkey-file",
          tsAuthKeyFile,
          "--git-ref",
          gitRef,
          ...extraArgs,
        ],
        { encoding: "utf8" },
      );
    }

    function clientConfig(output: string): Record<string, unknown> {
      const doc = parseYaml(output) as CloudInitDoc;
      const entry = doc.write_files.find(
        (item) => item.path === "/home/openclaw/.openclaw/openclaw.json",
      );
      return JSON.parse(entry?.content ?? "") as Record<string, unknown>;
    }

    it("renders a complete, ASCII-clean cloud-init without --tg-token-file or --owner-target", () => {
      const output = renderClient();
      expect(output).not.toMatch(UNRESOLVED_PLACEHOLDER_RE);
      expect(output).not.toContain("{{INCLUDE:");
      expect(output).toMatch(/^[\x00-\x7F]*$/);
      expect(output.trimStart().startsWith("#cloud-config")).toBe(true);

      const doc = parseYaml(output) as CloudInitDoc;
      expect(doc.power_state.mode).toBe("reboot");
      // Everything that makes the box a desk is still there.
      const paths = doc.write_files.map((entry) => entry.path);
      expect(paths).toContain("/etc/systemd/system/openclaw-gateway.service");
      expect(paths).toContain("/etc/openclaw/secrets/gateway-token");
      expect(paths).toContain("/home/openclaw/.openclaw/openclaw.json");
    });

    it("configures only desk plumbing: no channels, agents, bindings or hooks", () => {
      const config = clientConfig(renderClient());
      // The owner requirement this profile exists for: a client's desk starts where a fresh
      // install starts, so the Control UI's own onboarding (Model Setup, the first-conversation
      // naming ritual, adding Telegram from Settings) is what configures it — not this template.
      expect(Object.keys(config).sort()).toEqual([
        "browser",
        "gateway",
        "plugins",
        "secrets",
        "tools",
      ]);
      expect(config.channels).toBeUndefined();
      expect(config.agents).toBeUndefined();
      expect(config.bindings).toBeUndefined();
      expect(config.hooks).toBeUndefined();

      const gateway = config.gateway as Record<string, unknown>;
      expect(gateway.mode).toBe("local");
      expect(gateway.bind).toBe("loopback");
      expect(gateway.controlUi).toEqual({ communityInvite: false });
      expect(gateway.auth).toEqual({
        mode: "token",
        token: { source: "file", provider: "gateway-token-file", id: "value" },
      });
      expect((gateway.tailscale as { mode: string }).mode).toBe("serve");

      // The plugins a desk ships stay available but unconfigured — the client turns them on from
      // the Control UI rather than finding someone else's accounts already connected.
      expect(config.plugins).toEqual({
        entries: {
          anthropic: { enabled: true },
          duties: { enabled: true },
          telegram: { enabled: true },
          "llm-task": { enabled: true },
        },
      });
      expect(config.tools).toEqual({ alsoAllow: ["llm-task"] });
      expect(config.browser).toEqual({ ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } });

      // Only the Gateway token provider: a telegram-bot-token-file provider pointing at a file
      // that is never written would fail the Gateway's own secret resolution if anything read it.
      expect(config.secrets).toEqual({
        providers: {
          "gateway-token-file": {
            source: "file",
            path: "/etc/openclaw/secrets/gateway-token",
            mode: "singleValue",
          },
        },
      });
    });

    it("drops the Telegram secret file and the Gmail webhook Funnel, not just their contents", () => {
      const output = renderClient();
      const doc = parseYaml(output) as CloudInitDoc;
      // Skipped, never rendered empty: an empty 0600 file at this path would look configured to
      // anyone inspecting the desk, and to any later code that tests for its presence.
      expect(doc.write_files.map((entry) => entry.path)).not.toContain(
        "/etc/openclaw/secrets/telegram-bot-token",
      );
      expect(output).not.toContain("telegram-bot-token");
      // No hooks config means nothing listens on 8788; a public Funnel route to it would be an
      // exposed path with no backend.
      expect(output).not.toContain("tailscale funnel --bg");
      expect(output).not.toContain("gmail-pubsub");
      // Tailscale itself is desk plumbing and stays.
      expect(output).toContain('tailscale up --authkey "$(cat /root/ts-authkey)"');
      expect(output).toContain("tailscale set --operator=openclaw");
    });

    it("renders under --preflight too, with gateway.tailscale.mode off", () => {
      const output = renderClient(["--preflight"]);
      expect(clientConfig(output)).toMatchObject({ gateway: { tailscale: { mode: "off" } } });
      const skippedCount = output.split("# preflight: tailscale skipped").length - 1;
      // Two, not the owner profile's three: the Funnel line is not rendered at all here.
      expect(skippedCount).toBe(2);
    });

    it("says so rather than silently ignoring a bot token or owner target it cannot use", () => {
      const result = execFileSync(
        process.execPath,
        [
          RENDER_SCRIPT,
          "--profile",
          "client",
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
      expect(clientConfig(result)).not.toHaveProperty("channels");
      expect(result).not.toContain(tgTokenValue);
    });

    it("refuses an unknown profile", () => {
      try {
        execFileSync(
          process.execPath,
          [
            RENDER_SCRIPT,
            "--profile",
            "customer",
            "--name",
            deskName,
            "--ts-authkey-file",
            tsAuthKeyFile,
            "--git-ref",
            gitRef,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        );
        expect.unreachable("render should have thrown for an unknown --profile");
      } catch (error) {
        expect(String((error as { stderr?: string }).stderr ?? "")).toMatch(/--profile/);
      }
    });

    it("still requires the bot token and owner target under the owner profile", () => {
      // Dropping them from the owner profile would quietly ship the operator's own desk without
      // the channel it is reached on.
      for (const missing of ["--tg-token-file", "--owner-target"]) {
        const args = [
          RENDER_SCRIPT,
          "--profile",
          "owner",
          "--name",
          deskName,
          "--ts-authkey-file",
          tsAuthKeyFile,
          "--git-ref",
          gitRef,
          ...(missing === "--tg-token-file" ? ["--owner-target", ownerTarget] : []),
          ...(missing === "--owner-target" ? ["--tg-token-file", tgTokenFile] : []),
        ];
        try {
          execFileSync(process.execPath, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          });
          expect.unreachable(`render should have thrown without ${missing}`);
        } catch (error) {
          expect(String((error as { stderr?: string }).stderr ?? "")).toContain(
            `missing required ${missing}`,
          );
        }
      }
    });
  });

  it("leaves the owner profile byte-for-byte identical to the default render", () => {
    // The conditional sections exist for the client profile; the owner profile must render as if
    // they were never introduced, marker lines and all.
    const gatewayTokenFile = join(dir, "gateway-token");
    writeFileSync(gatewayTokenFile, "fixed-gateway-token-fixture\n");
    const fixedArgs = [
      "--gateway-token-file",
      gatewayTokenFile,
      "--repo-url",
      "https://github.com/example-org/example-fork",
    ];
    // The per-desk hooks token is minted randomly on every render, so it is the one value that
    // legitimately differs between two runs.
    const maskHooksToken = (text: string) =>
      text.replace(/HOOKS_TOKEN=[A-Za-z0-9_-]+/, "HOOKS_TOKEN=MASKED");

    const explicit = maskHooksToken(render([...fixedArgs, "--profile", "owner"]));
    const byDefault = maskHooksToken(render(fixedArgs));
    expect(explicit).toBe(byDefault);
    expect(byDefault).not.toContain("{{#IF:");
    expect(byDefault).not.toContain("{{/IF}}");
    expect(byDefault).toContain("/etc/openclaw/secrets/telegram-bot-token");
    expect(byDefault).toContain("tailscale funnel --bg --https=8443");
  });
});
