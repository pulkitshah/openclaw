import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createPluginSourceCapture,
  reclaimPluginSourceCapturesOnExit,
  reclaimStalePluginSourceCaptures,
} from "./plugin-package-metadata-capture.js";

// A capture directory outlives its process whenever that process never reaches dispose(): a
// SIGKILLed Gateway, a crash, or a CLI run that simply exits. Nothing else removes it, and a
// desk that restarts or runs the CLI often fills its disk with them. These tests cover the two
// owners of that cleanup: the once-per-process stale sweep and the exit-time reclaim.

let root: string;
// os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows; point all three at the fixture.
const TMP_ENV = ["TMPDIR", "TEMP", "TMP"] as const;
let previousTmpEnv: Partial<Record<(typeof TMP_ENV)[number], string | undefined>>;

function useFixtureTmpdir(): void {
  for (const name of TMP_ENV) {
    process.env[name] = root;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-capture-reclaim-test-"));
  previousTmpEnv = Object.fromEntries(TMP_ENV.map((name) => [name, process.env[name]]));
});

afterEach(() => {
  for (const name of TMP_ENV) {
    const previous = previousTmpEnv[name];
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** A pid that certainly belonged to a process which has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  expect(child.status).toBe(0);
  return child.pid;
}

function makeCaptureDirectory(name: string): string {
  const directory = path.join(root, name);
  fs.mkdirSync(path.join(directory, "package-0"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package-0", "index.cjs"), "");
  return directory;
}

it("removes capture directories whose owning process is gone, and leaves live, foreign and unnamed ones alone", () => {
  const stale = makeCaptureDirectory(`openclaw-plugin-build-${deadPid()}-abc123`);
  const mine = makeCaptureDirectory(`openclaw-plugin-build-${process.pid}-def456`);
  const parent = makeCaptureDirectory(`openclaw-plugin-build-${process.ppid}-ghi789`);
  // The shape every build before this cleanup used: no pid, so no liveness answer.
  const unnamed = makeCaptureDirectory("openclaw-plugin-build-jkl012");
  const unrelated = makeCaptureDirectory("openclaw-something-else-345");

  const removed = reclaimStalePluginSourceCaptures(root);

  expect(removed).toEqual([stale]);
  expect(fs.existsSync(stale)).toBe(false);
  for (const kept of [mine, parent, unnamed, unrelated]) {
    expect(fs.existsSync(kept)).toBe(true);
  }
});

it("removes at most the given number of stale directories per sweep, leaving the rest for the next process", () => {
  const pid = deadPid();
  const stale = ["a", "b", "c"].map((suffix) =>
    makeCaptureDirectory(`openclaw-plugin-build-${pid}-${suffix}`),
  );
  expect(reclaimStalePluginSourceCaptures(root, 2)).toHaveLength(2);
  expect(stale.filter((directory) => fs.existsSync(directory))).toHaveLength(1);
  expect(reclaimStalePluginSourceCaptures(root, 2)).toHaveLength(1);
  expect(stale.some((directory) => fs.existsSync(directory))).toBe(false);
});

it("names a new capture directory after its process and reclaims it at exit when dispose() never ran", () => {
  useFixtureTmpdir();
  const capture = createPluginSourceCapture();
  expect(path.dirname(capture.directory)).toBe(fs.realpathSync(root));
  expect(path.basename(capture.directory)).toMatch(
    new RegExp(`^openclaw-plugin-build-${process.pid}-`),
  );
  expect(process.listeners("exit")).toContain(reclaimPluginSourceCapturesOnExit);

  reclaimPluginSourceCapturesOnExit();

  expect(fs.existsSync(capture.directory)).toBe(false);
  // dispose() after the exit reclaim is still a no-op rather than an error.
  expect(() => capture.dispose()).not.toThrow();
});

it("forgets a disposed capture so the exit reclaim does not touch a directory handed back already", () => {
  useFixtureTmpdir();
  const capture = createPluginSourceCapture();
  capture.dispose();
  expect(fs.existsSync(capture.directory)).toBe(false);
  // Something else may legitimately reuse the path later; the exit hook must not remove it.
  fs.mkdirSync(capture.directory);
  reclaimPluginSourceCapturesOnExit();
  expect(fs.existsSync(capture.directory)).toBe(true);
});
