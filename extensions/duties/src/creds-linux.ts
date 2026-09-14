import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const MAGIC = "OCDC1"; // openclaw duties creds, format 1
const IV_BYTES = 12;

export type LinuxCredStore = {
  get(key: string): Promise<string>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
};

/** Servers have no keychain, so values live in one AES-256-GCM blob keyed by a root-owned keyfile
 *  the service user can read but not write (Vasudev's hosted-desk model). Every write re-encrypts
 *  the whole map with a fresh IV and lands via rename, so a crash never leaves a half-written store. */
export function createLinuxCredStore(opts?: {
  storePath?: string;
  keyfilePath?: string;
}): LinuxCredStore {
  const storePath =
    opts?.storePath ?? path.join(os.homedir(), ".openclaw", "plugins", "duties", "creds.enc");
  const keyfilePath =
    opts?.keyfilePath ?? process.env.DUTIES_CRED_KEYFILE ?? "/etc/openclaw/keyfile";
  let chain: Promise<void> = Promise.resolve();

  const deriveKey = async (): Promise<Buffer> => {
    let raw: Buffer;
    try {
      raw = await readFile(keyfilePath);
    } catch {
      throw new Error(
        `no credential keyfile at ${keyfilePath} — create it as root with 32 random bytes, readable by the service user`,
      );
    }
    if (raw.length < 16)
      throw new Error(`credential keyfile at ${keyfilePath} is too short (need 32 random bytes)`);
    return Buffer.from(hkdfSync("sha256", raw, "", "openclaw-duties-creds", 32));
  };

  const readMap = async (): Promise<Record<string, string>> => {
    let blob: Buffer;
    try {
      blob = await readFile(storePath);
    } catch {
      return {};
    }
    const key = await deriveKey();
    const magic = blob.subarray(0, MAGIC.length).toString();
    if (magic !== MAGIC || blob.length < MAGIC.length + IV_BYTES + 16) {
      throw new Error("credential store is corrupt or was written with another keyfile");
    }
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
    const tag = blob.subarray(blob.length - 16);
    const data = blob.subarray(MAGIC.length + IV_BYTES, blob.length - 16);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
      const parsed: unknown = JSON.parse(json);
      // SAFETY: the store only ever writes Record<string,string>; anything else fails the auth tag first.
      return parsed as Record<string, string>;
    } catch {
      throw new Error("credential store is corrupt or was written with another keyfile");
    }
  };

  const writeMap = async (map: Record<string, string>): Promise<void> => {
    const key = await deriveKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(map), "utf8")),
      cipher.final(),
    ]);
    const blob = Buffer.concat([Buffer.from(MAGIC), iv, data, cipher.getAuthTag()]);
    await mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
    const tmp = `${storePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, blob, { mode: 0o600 });
    await rename(tmp, storePath);
  };

  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const assertKey = (key: string) => {
    if (!KEY_RE.test(key)) throw new Error("invalid credential key");
  };

  return {
    async get(key) {
      assertKey(key);
      const map = await readMap();
      if (!Object.hasOwn(map, key)) throw new Error(`no credential stored for ${key}`);
      return map[key] ?? "";
    },
    set(key, value) {
      assertKey(key);
      if (!value) throw new Error("credential value is empty");
      return locked(async () => {
        const map = await readMap();
        map[key] = value;
        await writeMap(map);
      });
    },
    delete(key) {
      assertKey(key);
      return locked(async () => {
        const map = await readMap();
        if (!Object.hasOwn(map, key)) return false;
        delete map[key];
        await writeMap(map);
        return true;
      });
    },
    async has(key) {
      assertKey(key);
      return Object.hasOwn(await readMap(), key);
    },
  };
}
