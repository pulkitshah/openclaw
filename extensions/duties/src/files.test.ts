import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRunFiles } from "./files.js";

describe("createRunFiles", () => {
  it("creates per-run dirs and removes runs older than the cutoff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duties-files-"));
    const files = createRunFiles(root);
    const old = await files.runDir("old");
    const fresh = await files.runDir("fresh");
    await writeFile(path.join(old, "a.pdf"), "x");
    const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await utimes(old, past, past);
    const removed = await files.cleanup(30 * 24 * 3600 * 1000);
    expect(removed).toBe(1);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
    expect(await files.previewDir()).toBe(path.join(root, "previews"));
  });

  it("rejects a run id that would escape the runs directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duties-files-"));
    const files = createRunFiles(root);
    await expect(files.runDir("../x")).rejects.toThrow('invalid run id "../x"');
    await expect(files.runDir("550e8400-e29b-41d4-a716-446655440000")).resolves.toContain(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });
});
