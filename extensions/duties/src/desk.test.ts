import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDeskHealth } from "./desk.js";

describe("readDeskHealth", () => {
  it("reports not hosted when the health file is absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-desk-"));
    const missing = path.join(dir, "no-such-file.json");
    expect(await readDeskHealth(missing)).toEqual({ hosted: false });
  });

  it("parses a written health file, always reporting hosted:true on success", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-desk-"));
    const file = path.join(dir, "desk-health.json");
    await writeFile(
      file,
      JSON.stringify({
        hosted: true,
        at: 12345,
        gateway: true,
        display: true,
        chromium: false,
        tailscale: true,
        mailWatcher: true,
        load1: 0.42,
        memFreeMb: 512,
      }),
    );
    expect(await readDeskHealth(file)).toEqual({
      hosted: true,
      at: 12345,
      gateway: true,
      display: true,
      chromium: false,
      tailscale: true,
      mailWatcher: true,
      load1: 0.42,
      memFreeMb: 512,
    });
  });

  it("reports not hosted for malformed JSON instead of throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-desk-"));
    const file = path.join(dir, "desk-health.json");
    await writeFile(file, "{ not json");
    expect(await readDeskHealth(file)).toEqual({ hosted: false });
  });

  it("reports not hosted when the file parses to something other than an object", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-desk-"));
    const file = path.join(dir, "desk-health.json");
    await writeFile(file, "[1,2,3]");
    expect(await readDeskHealth(file)).toEqual({ hosted: false });
  });

  it("drops fields of the wrong type instead of passing them through", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-desk-"));
    const file = path.join(dir, "desk-health.json");
    await writeFile(file, JSON.stringify({ hosted: true, gateway: "yes", load1: "high", at: 5 }));
    expect(await readDeskHealth(file)).toEqual({ hosted: true, at: 5 });
  });
});
