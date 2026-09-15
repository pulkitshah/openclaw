import { execFile } from "node:child_process";
import { createLinuxCredStore, type LinuxCredStore } from "./creds-linux.js";

let linuxStore: LinuxCredStore | undefined;
/** Test-only injection point: lets tests point the Linux store at a temp dir/keyfile instead of
 *  the real `/etc/openclaw/keyfile` + `~/.openclaw/...` defaults. Pass `undefined` to reset. */
export function setLinuxCredStoreForTests(store?: LinuxCredStore): void {
  linuxStore = store;
}
const linux = (): LinuxCredStore => (linuxStore ??= createLinuxCredStore());

export type ExecFn = (
  file: string,
  args: string[],
  opts?: { input?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;
const CRED_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const HEX_RE = /^[0-9a-f]*$/u;
const SERVICE_PREFIX = "openclaw-duties.";
/** `security`/`powershell.exe` can wait for interactive input; nothing here is interactive, so a
 *  hung helper must become a failed step rather than a run that never ends. */
const EXEC_TIMEOUT_MS = 20_000;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env: opts?.env ?? process.env, maxBuffer: 1 << 20, timeout: EXEC_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(error.message));
        } else {
          resolve({ stdout });
        }
      },
    );
    if (opts?.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });

function assertKey(key: string): void {
  if (!CRED_KEY_RE.test(key)) {
    throw new Error("invalid credential key");
  }
}

export async function credGet(
  key: string,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFn = defaultExec,
): Promise<string> {
  assertKey(key);
  if (platform === "linux") {
    return linux().get(key);
  }
  if (platform === "darwin") {
    let stored: string;
    try {
      const { stdout } = await exec(
        "security",
        ["find-generic-password", "-s", SERVICE_PREFIX + key, "-w"],
        undefined,
      );
      stored = stdout.replace(/\n$/u, "");
    } catch {
      throw new Error(`no credential stored for ${key}`);
    }
    // Stored value is hex text (see credSet); decode it back to the original bytes here rather
    // than relying on `security`'s own `-X` hex handling, which on this OS only decodes hex that
    // maps to printable ASCII and silently stores non-printable/UTF-8 hex text literally. An item
    // written by hand (`security add-generic-password -w 'mypassword'`) is NOT hex, and
    // `Buffer.from` would silently truncate it into the wrong value — so refuse it instead.
    if (!HEX_RE.test(stored) || stored.length % 2 !== 0) {
      throw new Error(
        `credential ${key} was not stored by Vasudev; save it again from Duties → Logins`,
      );
    }
    return Buffer.from(stored, "hex").toString("utf8");
  }
  try {
    if (platform === "win32") {
      const { stdout } = await exec(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WIN_READ],
        {
          env: { ...process.env, OCD_TARGET: SERVICE_PREFIX + key },
        },
      );
      return stdout;
    }
  } catch {
    throw new Error(`no credential stored for ${key}`);
  }
  throw new Error(`credential store not supported on ${platform}`);
}

export async function credSet(
  key: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFn = defaultExec,
): Promise<void> {
  assertKey(key);
  // One condition, one message, on every platform — this check used to sit after the Linux
  // dispatch below, so an empty value reported "credential value is empty" on Linux and
  // "credential value must not be empty" everywhere else. On macOS it also matters mechanically:
  // an empty value would render as `-w \n` with no token, leaving `security -i` waiting for an
  // interactive password. There is no legitimate empty credential to store on either.
  if (!value) {
    throw new Error("credential value must not be empty");
  }
  if (platform === "linux") {
    return linux().set(key, value);
  }
  if (platform === "darwin") {
    // `security -i` reads commands from stdin, so the secret never appears in argv. The value is
    // hex-encoded (not quoted/escaped into the command text) so it can never break out of the
    // command line via a quote, backslash, or newline in the value: the hex alphabet [0-9a-f]
    // contains no shell/security metacharacters. We store the hex text itself (via `-w`) and
    // decode it back to bytes ourselves in credGet, rather than relying on `security add-generic-
    // password -X <hex>` to decode it: on this OS, `-X` only decodes hex that maps to printable
    // ASCII bytes and silently falls back to storing the hex text literally for non-printable or
    // multi-byte UTF-8 content (verified against a real keychain with a value containing a quote,
    // backslash, newline, and non-ASCII character) — precisely the values this needs to protect.
    const hex = Buffer.from(value, "utf8").toString("hex");
    try {
      await exec("security", ["-i"], {
        input: `add-generic-password -U -s "${SERVICE_PREFIX}${key}" -a openclaw -w ${hex}\n`,
      });
    } catch {
      throw new Error(`could not store credential ${key}`);
    }
    return;
  }
  if (platform === "win32") {
    try {
      await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_WRITE], {
        env: { ...process.env, OCD_TARGET: SERVICE_PREFIX + key, OCD_SECRET: value },
      });
    } catch {
      throw new Error(`could not store credential ${key}`);
    }
    return;
  }
  throw new Error(`credential store not supported on ${platform}`);
}

/** Removes a stored credential. Resolves `false` when there was nothing to remove. */
export async function credDelete(
  key: string,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFn = defaultExec,
): Promise<boolean> {
  assertKey(key);
  if (platform === "linux") {
    return linux().delete(key);
  }
  if (platform === "darwin") {
    try {
      await exec("security", ["delete-generic-password", "-s", SERVICE_PREFIX + key], undefined);
      return true;
    } catch {
      return false;
    }
  }
  if (platform === "win32") {
    try {
      await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_DELETE], {
        env: { ...process.env, OCD_TARGET: SERVICE_PREFIX + key },
      });
      return true;
    } catch {
      return false;
    }
  }
  throw new Error(`credential store not supported on ${platform}`);
}

export async function credHas(
  key: string,
  platform?: NodeJS.Platform,
  exec?: ExecFn,
): Promise<boolean> {
  if ((platform ?? process.platform) === "linux") {
    assertKey(key);
    return linux().has(key);
  }
  try {
    await credGet(key, platform, exec);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("no credential stored")) {
      return false;
    }
    throw error instanceof Error ? error : new Error(String(error));
  }
}

const WIN_CS = `
using System; using System.Runtime.InteropServices;
public static class OcdCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL c, uint f);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string t, uint ty, uint f, out IntPtr p);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string t, uint ty, uint f);
  [DllImport("advapi32")] static extern void CredFree(IntPtr p);
  public static void Delete(string target) { if (!CredDeleteW(target, 1, 0)) throw new Exception("not found"); }
  public static void Write(string target, string secret) {
    byte[] blob = System.Text.Encoding.Unicode.GetBytes(secret); IntPtr ptr = Marshal.AllocHGlobal(blob.Length); Marshal.Copy(blob, 0, ptr, blob.Length);
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.CredentialBlobSize = (uint)blob.Length; c.CredentialBlob = ptr; c.Persist = 2; c.UserName = "openclaw";
    bool ok = CredWriteW(ref c, 0); Marshal.FreeHGlobal(ptr); if (!ok) throw new Exception("CredWrite failed"); }
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) throw new Exception("not found");
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); if (c.CredentialBlobSize == 0) return "";
      byte[] b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize); return System.Text.Encoding.Unicode.GetString(b); }
    finally { CredFree(p); } } }`;
const WIN_READ = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WIN_CS}\n'@; [Console]::Out.Write([OcdCred]::Read($env:OCD_TARGET))`;
const WIN_WRITE = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WIN_CS}\n'@; [OcdCred]::Write($env:OCD_TARGET, $env:OCD_SECRET)`;
const WIN_DELETE = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WIN_CS}\n'@; [OcdCred]::Delete($env:OCD_TARGET)`;
