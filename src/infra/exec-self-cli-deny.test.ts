// Covers the self-CLI exec deny gate (Team v2 Task 5): binary-identity matching, both CLI aliases,
// the required non-regression against a path that merely contains the CLI name as a substring, and
// (fix-round follow-up) recursion into a shell-wrapper's inline payload (`bash -lc "..."`,
// `sh -c "..."`, nested dispatch/shell wrappers) so wrapping the self-CLI in a generic shell no
// longer bypasses the check.
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
    it("flags a bare `vasudev` invocation resolved through PATH", async () => {
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
      expect(await detectSelfCliInvocation([segment])).toBe(segment);
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

    it("does not flag a path that only contains the CLI name as a substring", async () => {
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
      expect(await detectSelfCliInvocation([segment])).toBeNull();
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

    it("returns false for a null resolution and null for an empty/undefined segment list", async () => {
      expect(isSelfCliCommandSegment(segmentFor(null, ["ls"]))).toBe(false);
      expect(await detectSelfCliInvocation([])).toBeNull();
      expect(await detectSelfCliInvocation(undefined)).toBeNull();
    });

    it("finds a self-CLI hit anywhere in a multi-segment shell chain", async () => {
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
      expect(await detectSelfCliInvocation([benign, hit])).toBe(hit);
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
      expect(await detectSelfCliInvocation(result.segments)).not.toBeNull();
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
      expect(await detectSelfCliInvocation(result.segments)).toBeNull();
    });
  });

  // Fix-round regression: `evaluateShellAllowlistWithAuthorization`'s own returned `segments` do
  // NOT include a shell wrapper's inline payload when the wrapper's startup mode makes it unsafe
  // to *cache* as a trusted command (e.g. a login shell — see `canUseWrapperShellInvocation` in
  // `exec-authorization-plan.ts`). Before this fix, that meant `bash -lc "vasudev ..."` produced
  // only a `bash` segment and `detectSelfCliInvocation` never saw the inner `vasudev` token at
  // all — a live, unconditional bypass of `denySelfCli` on both exec hosts. `detectSelfCliInvocation`
  // now recurses into the wrapper's inline payload itself (via the context param), independent of
  // that allow-path caching caution.
  describe("recurses into a shell-wrapper inline payload (fix: bash -lc / sh -c bypass)", () => {
    async function evalAndDetect(command: string, binDir: string, env: NodeJS.ProcessEnv) {
      const result = await evaluateShellAllowlistWithAuthorization({
        command,
        allowlist: [],
        safeBins: new Set(),
        cwd: binDir,
        env,
        platform: process.platform,
      });
      return detectSelfCliInvocation(result.segments, {
        cwd: binDir,
        env,
        platform: process.platform,
      });
    }

    it('catches `bash -lc "vasudev ..."` — the exact reviewer-verified bypass', async () => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "vasudev");
      const env = makePathEnv(binDir);
      const hit = await evalAndDetect(
        'bash -lc "vasudev pairing approve whatsapp ABC123"',
        binDir,
        env,
      );
      expect(hit).not.toBeNull();
    });

    it("catches `openclaw` (the second CLI alias) through the same `bash -lc` wrapper", async () => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "openclaw");
      const env = makePathEnv(binDir);
      const hit = await evalAndDetect('bash -lc "openclaw config set foo bar"', binDir, env);
      expect(hit).not.toBeNull();
    });

    it('catches a non-login `sh -c "vasudev ..."` wrapper too (not narrowly special-cased to `bash -lc`)', async () => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "vasudev");
      const env = makePathEnv(binDir);
      const hit = await evalAndDetect('sh -c "vasudev pairing list"', binDir, env);
      expect(hit).not.toBeNull();
    });

    it('catches a nested dispatch-then-shell-wrapper form (`env bash -lc "vasudev ..."`)', async () => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "vasudev");
      const env = makePathEnv(binDir);
      const hit = await evalAndDetect('env bash -lc "vasudev pairing list"', binDir, env);
      expect(hit).not.toBeNull();
    });

    it('catches a doubly-nested shell wrapper (`bash -lc "env bash -lc \\"vasudev ...\\""`)', async () => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "vasudev");
      const env = makePathEnv(binDir);
      const hit = await evalAndDetect(
        'bash -lc "env bash -lc \\"vasudev pairing list\\""',
        binDir,
        env,
      );
      expect(hit).not.toBeNull();
    });

    it("does not flag an ordinary command wrapped in `bash -lc` (non-regression)", async () => {
      const binDir = makeExecApprovalsTempDir();
      makeExecutable(binDir, "vasudev");
      const env = makePathEnv(binDir);
      const hit = await evalAndDetect('bash -lc "ls -la"', binDir, env);
      expect(hit).toBeNull();
    });

    it("does not flag a `bash -lc` payload merely containing the CLI name as a substring", async () => {
      const binDir = makeExecApprovalsTempDir();
      const env = makePathEnv(binDir);
      const hit = await evalAndDetect(
        'bash -lc "/home/vasudev-user/script.sh --help"',
        binDir,
        env,
      );
      expect(hit).toBeNull();
    });
  });
});
