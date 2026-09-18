// Covers the PATH-shadow environment layer for denySelfCli (Team v2 Task 5, structural-pivot fix
// round): the stub directory is prepared idempotently, contains a deny stub for every self-CLI
// bin name (including a Windows `.cmd` counterpart), the stub actually denies with a non-zero exit
// when really executed, and concurrent preparation calls converge on the same directory/content.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  clearSelfCliDenyPathShadowForTest,
  prepareSelfCliDenyPathShadow,
  SELF_CLI_DENY_STUB_MESSAGE,
} from "./exec-self-cli-deny-path-shadow.js";
import { SELF_CLI_BIN_NAMES } from "./exec-self-cli-deny.js";

const execFileAsync = promisify(execFile);

afterEach(() => {
  clearSelfCliDenyPathShadowForTest();
});

describe("exec self-CLI deny PATH shadow", () => {
  it("creates a POSIX and Windows-cmd stub for every self-CLI bin name", async () => {
    await withTempDir("openclaw-self-cli-shadow-", async (stateDir) => {
      const binDir = await prepareSelfCliDenyPathShadow({ stateDir });
      for (const name of SELF_CLI_BIN_NAMES) {
        const posixStat = await fs.stat(path.join(binDir, name));
        expect(posixStat.isFile()).toBe(true);
        const cmdStat = await fs.stat(path.join(binDir, `${name}.cmd`));
        expect(cmdStat.isFile()).toBe(true);
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "really denies with a non-zero exit and the deny message when executed",
    async () => {
      await withTempDir("openclaw-self-cli-shadow-exec-", async (stateDir) => {
        const binDir = await prepareSelfCliDenyPathShadow({ stateDir });
        const stat = await fs.stat(path.join(binDir, "vasudev"));
        // Owner-executable (0700-family) so PATH resolution can actually run it.
        expect(stat.mode & 0o100).toBeTruthy();
        await expect(
          execFileAsync(path.join(binDir, "vasudev"), ["pairing", "approve"]),
        ).rejects.toMatchObject({
          code: 1,
          stderr: expect.stringContaining(SELF_CLI_DENY_STUB_MESSAGE),
        });
      });
    },
  );

  it("is idempotent: concurrent preparation calls resolve to the same directory", async () => {
    await withTempDir("openclaw-self-cli-shadow-concurrent-", async (stateDir) => {
      const [a, b, c] = await Promise.all([
        prepareSelfCliDenyPathShadow({ stateDir }),
        prepareSelfCliDenyPathShadow({ stateDir }),
        prepareSelfCliDenyPathShadow({ stateDir }),
      ]);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
  });

  it("reuses the cached directory on a later call without re-preparing", async () => {
    await withTempDir("openclaw-self-cli-shadow-cache-", async (stateDir) => {
      const first = await prepareSelfCliDenyPathShadow({ stateDir });
      // Mutate the stub after first preparation; a cached second call must not rewrite it.
      await fs.writeFile(path.join(first, "vasudev"), "mutated");
      const second = await prepareSelfCliDenyPathShadow({ stateDir });
      expect(second).toBe(first);
      const content = await fs.readFile(path.join(first, "vasudev"), "utf8");
      expect(content).toBe("mutated");
    });
  });

  // Round 5 finding: once cached, the directory was never re-verified on later calls, so an
  // ordinary command deleting it mid-session (an easy thing to do -- $OPENCLAW_STATE_DIR is a
  // visible env var in every exec'd command, denySelfCli or not) left every later denySelfCli
  // call trusting a directory that no longer existed on disk.
  it("repairs the stub directory on the next call after it is deleted (self-repair, round 5)", async () => {
    await withTempDir("openclaw-self-cli-shadow-repair-dir-", async (stateDir) => {
      const first = await prepareSelfCliDenyPathShadow({ stateDir });
      await fs.rm(first, { recursive: true, force: true });
      expect(
        await fs.stat(first).then(
          () => true,
          () => false,
        ),
      ).toBe(false);

      const second = await prepareSelfCliDenyPathShadow({ stateDir });

      expect(second).toBe(first);
      for (const name of SELF_CLI_BIN_NAMES) {
        const posixStat = await fs.stat(path.join(second, name));
        expect(posixStat.isFile()).toBe(true);
        const cmdStat = await fs.stat(path.join(second, `${name}.cmd`));
        expect(cmdStat.isFile()).toBe(true);
      }
    });
  });

  it("repairs a single missing stub file without disturbing the rest (self-repair, round 5)", async () => {
    await withTempDir("openclaw-self-cli-shadow-repair-file-", async (stateDir) => {
      const first = await prepareSelfCliDenyPathShadow({ stateDir });
      await fs.rm(path.join(first, "vasudev"), { force: true });

      const second = await prepareSelfCliDenyPathShadow({ stateDir });

      expect(second).toBe(first);
      const stat = await fs.stat(path.join(second, "vasudev"));
      expect(stat.isFile()).toBe(true);
    });
  });

  it("does not repair an intact directory (no unnecessary rewrite)", async () => {
    await withTempDir("openclaw-self-cli-shadow-no-repair-", async (stateDir) => {
      const first = await prepareSelfCliDenyPathShadow({ stateDir });
      const before = await fs.stat(path.join(first, "vasudev"));

      const second = await prepareSelfCliDenyPathShadow({ stateDir });

      expect(second).toBe(first);
      const after = await fs.stat(path.join(first, "vasudev"));
      // Same inode/mtime: writeSelfCliDenyStubFiles never ran again.
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.ino).toBe(before.ino);
    });
  });
});
