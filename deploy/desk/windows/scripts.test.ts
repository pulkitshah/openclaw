import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import downloads from "./downloads.json" with { type: "json" };

// Parses every PowerShell script in this directory with PowerShell 7. Catches syntax errors
// before a script ever runs on a client VM. `pwsh` comes from PATH, from VASUDEV_PWSH, or from
// the tarball install deploy/desk/README.md describes (~/.local/powershell/pwsh - resolved from
// the account's passwd entry, because the test harness points $HOME at a scratch directory);
// the checks are skipped where none exists so the lane stays green on runners without it.
const HERE = dirname(fileURLToPath(import.meta.url));
const PWSH_CANDIDATES = [
  process.env.VASUDEV_PWSH ?? "",
  "pwsh",
  join(userInfo().homedir, ".local", "powershell", "pwsh"),
].filter((candidate) => candidate !== "");
const pwsh = PWSH_CANDIDATES.find((candidate) => {
  if (candidate !== "pwsh" && !existsSync(candidate)) {
    return false;
  }
  return spawnSync(candidate, ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).status === 0;
});

describe.runIf(pwsh !== undefined)("deploy/desk/windows PowerShell scripts", () => {
  const scripts = readdirSync(HERE).filter((name) => name.endsWith(".ps1"));
  it("has scripts to check", () => {
    expect(scripts.length).toBeGreaterThan(0);
  });
  it.each(scripts)("%s parses without errors", (name) => {
    const file = join(HERE, name).replace(/'/g, "''");
    const check = spawnSync(
      pwsh as string,
      [
        "-NoProfile",
        "-Command",
        `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e)|Out-Null; if($e.Count){$e|ForEach-Object{$_.ToString()}; exit 1}`,
      ],
      { encoding: "utf8" },
    );
    expect(check.status, check.stdout + check.stderr).toBe(0);
  });
  it.each(scripts)("%s is LF-only (PowerShell 5.1 reads it from a bash heredoc)", (name) => {
    expect(readFileSync(join(HERE, name), "utf8").includes("\r")).toBe(false);
  });
});

describe("downloads.json", () => {
  it("pins every installer with an https url and a 64-hex sha256", () => {
    const entries = downloads as Record<string, { url: string; sha256: string }>;
    for (const [name, entry] of Object.entries(entries)) {
      expect(entry.url, name).toMatch(/^https:\/\//);
      expect(entry.sha256, name).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining([
        "tailscale",
        "tightvnc",
        "caddy",
        "node",
        "git",
        "autologon",
        "vcredist",
      ]),
    );
  });
});

describe("openclaw.windows-desk.json.tmpl", () => {
  function validate(config: string): { status: number | null; output: string } {
    const dir = mkdtempSync(join(tmpdir(), "windows-desk-config-"));
    try {
      writeFileSync(join(dir, "openclaw.json"), config);
      const result = spawnSync(
        process.execPath,
        [join(HERE, "..", "..", "..", "openclaw.mjs"), "config", "validate"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: dir,
            OPENCLAW_CONFIG_PATH: join(dir, "openclaw.json"),
          },
        },
      );
      return { status: result.status, output: result.stdout + result.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const rendered = readFileSync(join(HERE, "openclaw.windows-desk.json.tmpl"), "utf8")
    .replaceAll("{{OWNER_EMAIL}}", "owner@example.com")
    .replaceAll("{{TAILNET_HOST}}", "acme-az.tailnet-fixture.ts.net")
    .replaceAll("{{FRONT_DOOR_ORIGIN}}", "https://vasudev.tripinstudio.com")
    // The validator checks path.isAbsolute with the host's rules; on the VM "C:\\..." is
    // absolute, on this Mac only a posix path is.
    .replace(
      "C:\\\\opt\\\\vnc-password.txt",
      process.platform === "win32" ? "C:\\\\opt\\\\vnc-password.txt" : "/opt/vnc-password.txt",
    );

  it("renders to a config the fork's schema accepts", () => {
    const result = validate(rendered);
    expect(result.status, result.output).toBe(0);
  });

  // The front door already authenticated the user; a fresh desk must not make the owner approve
  // their own browser by hand on the VM. operator.admin stays out of the device grant (the
  // identityScopes line adds it per connection) so the CRITICAL auto-approve-admin audit finding
  // never fires.
  it("auto-approves browsers that the front door authenticated", () => {
    const config = JSON.parse(rendered) as {
      gateway: {
        auth: { trustedProxy: { deviceAutoApprove?: { enabled?: boolean; scopes?: string[] } } };
      };
    };
    const autoApprove = config.gateway.auth.trustedProxy.deviceAutoApprove;
    expect(autoApprove?.enabled).toBe(true);
    expect(autoApprove?.scopes ?? []).not.toContain("operator.admin");
  });

  it("is checked by a validator that rejects an unknown trusted-proxy key", () => {
    const broken = rendered.replace(
      '"allowLoopback": true',
      '"allowLoopback": true, "allowTailscale": true',
    );
    const result = validate(broken);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("allowTailscale");
  });
});

describe("first-boot.ps1", () => {
  const script = readFileSync(join(HERE, "first-boot.ps1"), "utf8");

  // The desk's agents run through the claude-cli provider; the Linux recipe installs the CLI at
  // first boot (cloud-init) and the Windows one did not (onboarding failed live 2026-10-16 with
  // "Claude CLI is not authenticated on this host" because there was no CLI at all). npm 11
  // skips install scripts by default and claude-code needs its postinstall.
  it("installs the Claude CLI with npm, allowing its install scripts", () => {
    expect(script).toContain("--allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code");
    expect(script).toContain("claude --version");
  });
});

describe("provision-desk.ps1", () => {
  const script = readFileSync(join(HERE, "provision-desk.ps1"), "utf8");

  // The portal terminal's first-run onboarding types `vasudev onboard ...`, and the runbook's
  // admin recipes say `vasudev`; on the Linux desks /usr/local/bin/vasudev provides it. Without
  // a shim on the machine PATH the pre-typed command fails with "not recognized" (seen live
  // 2026-10-16).
  it("installs vasudev and openclaw command shims on the machine PATH", () => {
    expect(script).toContain('"vasudev", "openclaw"');
    expect(script).toContain("C:\\opt\\bin");
    expect(script).toContain('dist\\index.js`" %*');
  });
});

describe("receive-build.ps1 manifest", () => {
  it.runIf(pwsh !== undefined)(
    "matches push-build.sh's bash manifest on mixed-case names, hidden files and excluded plugin node_modules",
    () => {
      const dist = mkdtempSync(join(tmpdir(), "dist-parity-"));
      try {
        mkdirSync(join(dist, "dist", "extensions", "demo", "node_modules", "dep"), {
          recursive: true,
        });
        mkdirSync(join(dist, "packages", "ai", "dist"), { recursive: true });
        writeFileSync(join(dist, "dist", "index.js"), "a\n");
        writeFileSync(join(dist, "dist", "chunk-B1.mjs"), "b\n");
        writeFileSync(join(dist, "dist", "chunk-a2.mjs"), "c\n");
        writeFileSync(join(dist, "dist", "chunk_z.mjs"), "d\n");
        writeFileSync(join(dist, "dist", ".provision-built-ref"), "abc\n");
        writeFileSync(join(dist, "dist", "extensions", "demo", "index.js"), "e\n");
        writeFileSync(
          join(dist, "dist", "extensions", "demo", "node_modules", "dep", "x.js"),
          "ignored\n",
        );
        writeFileSync(join(dist, "packages", "ai", "dist", "diagnostics.mjs"), "f\n");
        const bash = spawnSync(
          "bash",
          [
            "-c",
            "cd \"$1\" && find ./dist ./packages/ai/dist -type f -not -path './dist/extensions/*/node_modules/*' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1; find ./dist ./packages/ai/dist -type f -not -path './dist/extensions/*/node_modules/*' | wc -l | tr -d ' '",
            "_",
            dist,
          ],
          { encoding: "utf8" },
        );
        expect(bash.status, bash.stderr).toBe(0);
        const [bashManifest, bashCount] = bash.stdout.trim().split("\n");
        const ps = spawnSync(
          pwsh as string,
          ["-NoProfile", "-File", join(HERE, "receive-build.ps1"), "-ManifestOnly", dist],
          { encoding: "utf8" },
        );
        expect(ps.status, ps.stdout + ps.stderr).toBe(0);
        const [psManifest, psCount] = ps.stdout.trim().split(" ");
        expect(psCount).toBe(bashCount);
        expect(psManifest).toBe(bashManifest);
      } finally {
        rmSync(dist, { recursive: true, force: true });
      }
    },
  );
});
