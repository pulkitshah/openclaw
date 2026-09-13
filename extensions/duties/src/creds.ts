import { execFile } from "node:child_process";

export type ExecFn = (
  file: string,
  args: string[],
  opts?: { input?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;
export const CRED_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const SERVICE_PREFIX = "openclaw-duties.";

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env: opts?.env ?? process.env, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout) });
      },
    );
    if (opts?.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });

function assertKey(key: string): void {
  if (!CRED_KEY_RE.test(key)) throw new Error("invalid credential key");
}

export async function credGet(
  key: string,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFn = defaultExec,
): Promise<string> {
  assertKey(key);
  try {
    if (platform === "darwin") {
      const { stdout } = await exec(
        "security",
        ["find-generic-password", "-s", SERVICE_PREFIX + key, "-w"],
        undefined,
      );
      // Stored value is hex text (see credSet); decode it back to the original bytes here rather
      // than relying on `security`'s own `-X` hex handling, which on this OS only decodes hex that
      // maps to printable ASCII and silently stores non-printable/UTF-8 hex text literally.
      return Buffer.from(stdout.replace(/\n$/u, ""), "hex").toString("utf8");
    }
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

export async function credHas(
  key: string,
  platform?: NodeJS.Platform,
  exec?: ExecFn,
): Promise<boolean> {
  try {
    await credGet(key, platform, exec);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("no credential stored")) return false;
    throw error;
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
  [DllImport("advapi32")] static extern void CredFree(IntPtr p);
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
