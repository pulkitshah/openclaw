import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLinuxCredStore } from "./creds-linux.js";

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "duties-creds-"));
  const keyfilePath = path.join(dir, "keyfile");
  await writeFile(keyfilePath, randomBytes(32), { mode: 0o600 });
  return { dir, keyfilePath, storePath: path.join(dir, "creds.enc") };
}

describe("createLinuxCredStore", () => {
  it("round-trips values, lists presence, and deletes", async () => {
    const f = await fixture();
    const store = createLinuxCredStore(f);
    await store.set("acme-demo.password", "p@ss\nwith newline");
    expect(await store.get("acme-demo.password")).toBe("p@ss\nwith newline");
    expect(await store.has("acme-demo.password")).toBe(true);
    expect(await store.has("nope")).toBe(false);
    expect(await store.delete("acme-demo.password")).toBe(true);
    await expect(store.get("acme-demo.password")).rejects.toThrow(
      /no credential stored for acme-demo\.password/u,
    );
  });
  it("never writes the value in clear and detects tampering", async () => {
    const f = await fixture();
    const store = createLinuxCredStore(f);
    await store.set("k", "SECRET-VALUE");
    const raw = await readFile(f.storePath);
    expect(raw.includes("SECRET-VALUE")).toBe(false);
    const last = raw.length - 1;
    raw[last] = (raw[last] ?? 0) ^ 0xff;
    await writeFile(f.storePath, raw);
    await expect(store.get("k")).rejects.toThrow(
      /credential store is corrupt or was written with another keyfile/u,
    );
  });
  it("names the missing keyfile", async () => {
    const f = await fixture();
    const store = createLinuxCredStore({
      storePath: f.storePath,
      keyfilePath: path.join(f.dir, "missing"),
    });
    await expect(store.set("k", "v")).rejects.toThrow(
      /no credential keyfile at .*missing — create it as root with 32 random bytes, readable by the service user/u,
    );
  });
  it("defaults the store into the Gateway's own state dir, honouring OPENCLAW_STATE_DIR", async () => {
    // The plugin must not compute `~/.openclaw` itself: on an install whose state dir is elsewhere
    // (OPENCLAW_STATE_DIR, as the owner's own layout uses) a self-resolved path saves logins
    // outside the Gateway's state tree — invisible to `duties.cred.list`, and not carried by a
    // state backup or migration.
    const f = await fixture();
    const stateDir = path.join(f.dir, "state");
    const previous = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const store = createLinuxCredStore({ keyfilePath: f.keyfilePath });
      await store.set("site.password", "value");
      expect(
        await readFile(path.join(stateDir, "plugins", "duties", "creds.enc")),
      ).not.toHaveLength(0);
      expect(await store.get("site.password")).toBe("value");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previous;
      }
    }
  });

  it("serializes concurrent writes", async () => {
    const f = await fixture();
    const store = createLinuxCredStore(f);
    await Promise.all(["a", "b", "c", "d"].map((k) => store.set(k, `v-${k}`)));
    for (const k of ["a", "b", "c", "d"]) {
      expect(await store.get(k)).toBe(`v-${k}`);
    }
  });
});
