import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
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
      expect.arrayContaining(["tailscale", "tightvnc", "caddy", "node", "git", "autologon"]),
    );
  });
});
