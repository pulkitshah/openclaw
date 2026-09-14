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
    await store.set("amigos.password", "p@ss\nwith newline");
    expect(await store.get("amigos.password")).toBe("p@ss\nwith newline");
    expect(await store.has("amigos.password")).toBe(true);
    expect(await store.has("nope")).toBe(false);
    expect(await store.delete("amigos.password")).toBe(true);
    await expect(store.get("amigos.password")).rejects.toThrow(
      /no credential stored for amigos\.password/u,
    );
  });
  it("never writes the value in clear and detects tampering", async () => {
    const f = await fixture();
    const store = createLinuxCredStore(f);
    await store.set("k", "SECRET-VALUE");
    const raw = await readFile(f.storePath);
    expect(raw.includes("SECRET-VALUE")).toBe(false);
    raw[raw.length - 1] ^= 0xff;
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
  it("serializes concurrent writes", async () => {
    const f = await fixture();
    const store = createLinuxCredStore(f);
    await Promise.all(["a", "b", "c", "d"].map((k) => store.set(k, `v-${k}`)));
    for (const k of ["a", "b", "c", "d"]) expect(await store.get(k)).toBe(`v-${k}`);
  });
});
