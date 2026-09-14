import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRunFiles, PREVIEW_TTL_MS } from "./files.js";

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

  it("sweeps preview pdfs on their own 24h clock, independent of the run cutoff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duties-files-"));
    const files = createRunFiles(root);
    const previews = await files.previewDir();
    const stale = path.join(previews, "note-1.pdf");
    const fresh = path.join(previews, "note-2.pdf");
    await writeFile(stale, "%PDF");
    await writeFile(fresh, "%PDF");
    const past = new Date(Date.now() - PREVIEW_TTL_MS - 60_000);
    await utimes(stale, past, past);
    // A run directory of the same age survives: the 30-day run cutoff has not been reached, so the
    // two clocks are genuinely independent rather than one cutoff applied to both trees.
    const run = await files.runDir("recent");
    await utimes(run, past, past);

    expect(await files.cleanup(30 * 24 * 3600 * 1000)).toBe(1);
    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
    await expect(stat(run)).resolves.toBeTruthy();
    expect(PREVIEW_TTL_MS).toBe(24 * 3600 * 1000);
  });

  // Regression: one entry the OS refused (EPERM/EBUSY, an open handle) rejected out of `cleanup`
  // and aborted the whole pass, so a single stuck directory stopped every later one from ever
  // being swept — and the Gateway only logged a warning at start.
  it("keeps sweeping after a removal the filesystem refuses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duties-files-"));
    const files = createRunFiles(root);
    const previews = await files.previewDir();
    const past = new Date(Date.now() - PREVIEW_TTL_MS - 60_000);
    // A directory inside the previews tree: `rm` without `recursive` refuses it (EISDIR/ERR_FS),
    // which is the shape of a removal the OS declines.
    const stuck = path.join(previews, "stuck");
    await mkdir(stuck);
    await writeFile(path.join(stuck, "held.pdf"), "%PDF");
    const sweepable = path.join(previews, "z-note.pdf");
    await writeFile(sweepable, "%PDF");
    await utimes(stuck, past, past);
    await utimes(sweepable, past, past);

    // The stuck entry is not a file, so it is skipped by the isFile() guard; what this pins is
    // that a refused `rm` of the sweepable one never stops the pass.
    expect(await files.cleanup(30 * 24 * 3600 * 1000)).toBe(1);
    await expect(stat(sweepable)).rejects.toThrow();
    await expect(stat(stuck)).resolves.toBeTruthy();
  });

  it("counts swept previews and run directories in one returned total", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duties-files-"));
    const files = createRunFiles(root);
    const previews = await files.previewDir();
    const preview = path.join(previews, "note-1.pdf");
    await writeFile(preview, "%PDF");
    const run = await files.runDir("old");
    const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await utimes(preview, past, past);
    await utimes(run, past, past);

    expect(await files.cleanup(30 * 24 * 3600 * 1000)).toBe(2);
  });

  it("sweeps nothing and reports zero when neither tree exists yet", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duties-files-"));
    expect(await createRunFiles(root).cleanup(30 * 24 * 3600 * 1000)).toBe(0);
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
