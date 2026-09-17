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
});
