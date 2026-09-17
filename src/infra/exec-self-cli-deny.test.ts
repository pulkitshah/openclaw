// Covers the self-CLI exec deny gate (Team v2 Task 5): binary-identity matching, both CLI aliases,
// and the required non-regression against a path that merely contains the CLI name as a substring.
import { describe, expect, it } from "vitest";
import {
  makeExecApprovalsTempDir,
  makeExecutable,
  makeMockCommandResolution,
  makeMockExecutableResolution,
  makePathEnv,
} from "./exec-approvals-test-helpers.js";
import { evaluateShellAllowlistWithAuthorization } from "./exec-approvals.js";
import type { ExecCommandSegment } from "./exec-command-analysis-types.js";
import { detectSelfCliInvocation, isSelfCliCommandSegment } from "./exec-self-cli-deny.js";

function segmentFor(
  resolution: ExecCommandSegment["resolution"],
  argv: string[],
): ExecCommandSegment {
  return { raw: argv.join(" "), argv, resolution };
}

describe("exec self-CLI deny", () => {
  describe("isSelfCliCommandSegment / detectSelfCliInvocation (unit, mocked resolution)", () => {
    it("flags a bare `vasudev` invocation resolved through PATH", () => {
      const resolution = makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "vasudev",
          executableName: "vasudev",
          resolvedPath: "/usr/local/bin/vasudev",
          resolvedRealPath: "/usr/local/bin/vasudev",
        }),
      });
      const segment = segmentFor(resolution, [
        "vasudev",
        "pairing",
        "approve",
        "whatsapp",
        "ABC123",
      ]);
      expect(isSelfCliCommandSegment(segment)).toBe(true);
      expect(detectSelfCliInvocation([segment])).toBe(segment);
    });

    it("flags the `openclaw` alias identically (same entry point, package.json `bin`)", () => {
      const resolution = makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "openclaw",
          executableName: "openclaw",
          resolvedPath: "/usr/local/bin/openclaw",
          resolvedRealPath: "/usr/local/lib/node_modules/vasudev/openclaw.mjs",
        }),
      });
      const segment = segmentFor(resolution, ["openclaw", "config", "set", "foo", "bar"]);
      expect(isSelfCliCommandSegment(segment)).toBe(true);
    });

    it("flags an absolute-path invocation of the CLI, unlike allowlist bare-name matching", () => {
      // Allowlist bare-name entries deliberately do NOT match a path-qualified invocation
      // (see matchesExecutableBasenamePattern's hasPathSelector guard) — a denial must not
      // inherit that same escape hatch, so this checks the opposite: a full path still hits.
      const resolution = makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "/usr/local/bin/vasudev",
          executableName: "vasudev",
          resolvedPath: "/usr/local/bin/vasudev",
          resolvedRealPath: "/usr/local/bin/vasudev",
        }),
      });
      const segment = segmentFor(resolution, ["/usr/local/bin/vasudev", "pairing", "list"]);
      expect(isSelfCliCommandSegment(segment)).toBe(true);
    });

    it("flags a relative invocation (./vasudev) via its raw token even if unresolved", () => {
      const resolution = makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "./vasudev",
          executableName: "./vasudev",
        }),
      });
      const segment = segmentFor(resolution, ["./vasudev", "pairing", "list"]);
      expect(isSelfCliCommandSegment(segment)).toBe(true);
    });

    it("strips a Windows executable extension before comparing (vasudev.exe / vasudev.cmd)", () => {
      const resolution = makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "vasudev",
          executableName: "vasudev.cmd",
          resolvedPath: "C:\\Users\\me\\AppData\\Roaming\\npm\\vasudev.cmd",
        }),
      });
      const segment = segmentFor(resolution, ["vasudev", "pairing", "list"]);
      expect(isSelfCliCommandSegment(segment)).toBe(true);
    });

    it("does not flag a path that only contains the CLI name as a substring", () => {
      const resolution = makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "/home/vasudev-user/script.sh",
          executableName: "script.sh",
          resolvedPath: "/home/vasudev-user/script.sh",
          resolvedRealPath: "/home/vasudev-user/script.sh",
        }),
      });
      const segment = segmentFor(resolution, ["/home/vasudev-user/script.sh"]);
      expect(isSelfCliCommandSegment(segment)).toBe(false);
      expect(detectSelfCliInvocation([segment])).toBeNull();
    });

    it("does not flag an unrelated command (ls)", () => {
      const resolution = makeMockCommandResolution({
        execution: makeMockExecutableResolution({
          rawExecutable: "ls",
          executableName: "ls",
          resolvedPath: "/bin/ls",
          resolvedRealPath: "/bin/ls",
        }),
      });
      const segment = segmentFor(resolution, ["ls", "-la"]);
      expect(isSelfCliCommandSegment(segment)).toBe(false);
    });

    it("returns false for a null resolution and null for an empty/undefined segment list", () => {
      expect(isSelfCliCommandSegment(segmentFor(null, ["ls"]))).toBe(false);
      expect(detectSelfCliInvocation([])).toBeNull();
      expect(detectSelfCliInvocation(undefined)).toBeNull();
    });

    it("finds a self-CLI hit anywhere in a multi-segment shell chain", () => {
      const benign = segmentFor(
        makeMockCommandResolution({
          execution: makeMockExecutableResolution({
            rawExecutable: "ls",
            executableName: "ls",
            resolvedPath: "/bin/ls",
          }),
        }),
        ["ls"],
      );
      const hit = segmentFor(
        makeMockCommandResolution({
          execution: makeMockExecutableResolution({
            rawExecutable: "vasudev",
            executableName: "vasudev",
            resolvedPath: "/usr/local/bin/vasudev",
          }),
        }),
        ["vasudev", "pairing", "approve", "telegram", "999"],
      );
      expect(detectSelfCliInvocation([benign, hit])).toBe(hit);
    });
  });

  describe("end-to-end through the real exec-approvals resolution pipeline", () => {
    it("catches a bare `vasudev` command resolved through a real PATH lookup", async () => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "vasudev");
      const env = makePathEnv(binDir);
      const result = await evaluateShellAllowlistWithAuthorization({
        command: "vasudev pairing approve whatsapp ABC123",
        allowlist: [],
        safeBins: new Set(),
        cwd: binDir,
        env,
        platform: process.platform,
      });
      expect(result.analysisOk).toBe(true);
      expect(detectSelfCliInvocation(result.segments)).not.toBeNull();
    });

    it("leaves an ordinary command's real resolution unaffected (non-regression)", async () => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "vasudev");
      const env = makePathEnv(binDir);
      const result = await evaluateShellAllowlistWithAuthorization({
        command: "vasudev-user-script.sh --help",
        allowlist: [],
        safeBins: new Set(),
        cwd: binDir,
        env,
        platform: process.platform,
      });
      // The command itself is not resolvable (it isn't the fixture's `vasudev` binary and doesn't
      // exist), which is fine here: the point is that its *name* containing "vasudev" as a
      // substring never gets treated as a hit.
      expect(detectSelfCliInvocation(result.segments)).toBeNull();
    });
  });
});
