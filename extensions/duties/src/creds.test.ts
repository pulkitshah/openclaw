import { describe, expect, it, vi } from "vitest";
import { credGet, credHas, credSet } from "./creds.js";
import type { ExecFn } from "./creds.js";

// Explicitly typed to ExecFn's parameter shape so `mock.calls[0]` is always inferred as the real
// 3-tuple `[file, args, opts]` regardless of which tsconfig project checks this file.
function mockExec(
  impl: (
    file: string,
    args: string[],
    opts?: { input?: string; env?: NodeJS.ProcessEnv },
  ) => ReturnType<ExecFn>,
) {
  return vi.fn(impl);
}

describe("creds (macOS)", () => {
  it("reads through `security find-generic-password -w` with a namespaced service", async () => {
    // Stored values are hex text (see credSet); credGet decodes them back to the original bytes.
    const hex = Buffer.from("s3cret", "utf8").toString("hex");
    const exec = mockExec(async () => ({ stdout: `${hex}\n` }));
    await expect(credGet("amigos.password", "darwin", exec)).resolves.toBe("s3cret");
    expect(exec).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "openclaw-duties.amigos.password", "-w"],
      undefined,
    );
  });
  it("never puts the value on argv when saving; it goes via stdin (hex-encoded)", async () => {
    const exec = mockExec(async () => ({ stdout: "" }));
    await credSet("amigos.password", "s3cret", "darwin", exec);
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("security");
    expect(args.join(" ")).not.toContain("s3cret");
    expect(opts?.input).not.toContain("s3cret");
    expect(opts?.input).toContain(Buffer.from("s3cret", "utf8").toString("hex"));
  });
  it("maps a missing item to a plain error without echoing security's stderr", async () => {
    const exec = mockExec(async () => {
      throw new Error("security: SecKeychainSearchCopyNext: openclaw-duties.x");
    });
    await expect(credGet("x", "darwin", exec)).rejects.toThrow("no credential stored for x");
    await expect(credHas("x", "darwin", exec)).resolves.toBe(false);
  });
  it("rejects malformed keys", async () => {
    await expect(
      credGet(
        "Bad Key!",
        "darwin",
        mockExec(async () => ({ stdout: "" })),
      ),
    ).rejects.toThrow("invalid credential key");
  });
  it("hex-encodes the value so quotes, backslashes, and newlines can't break out of the stdin command", async () => {
    const exec = mockExec(async () => ({ stdout: "" }));
    const value = 'p"a\\ss\nword';
    await credSet("amigos.password", value, "darwin", exec);
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("security");
    expect(args).toEqual(["-i"]);
    const hex = Buffer.from(value, "utf8").toString("hex");
    expect(opts?.input).toContain(hex);
    expect(opts?.input).not.toContain(value);
    expect(opts?.input).not.toContain('p"a');
    expect(opts?.input).not.toContain("\\ss");
  });
  it("maps a failed save to a plain error without echoing the value or security's stderr", async () => {
    const value = "s3cret-value";
    const exec = mockExec(async () => {
      throw new Error(`security: some failure involving ${value}`);
    });
    await expect(credSet("amigos.password", value, "darwin", exec)).rejects.toThrow(
      "could not store credential amigos.password",
    );
    try {
      await credSet("amigos.password", value, "darwin", exec);
      throw new Error("expected credSet to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toBe("could not store credential amigos.password");
      expect(message).not.toContain(value);
    }
  });
});

describe("creds (windows)", () => {
  it("reads via a fixed PowerShell script, keeping the key and value out of argv", async () => {
    const exec = mockExec(async () => ({ stdout: "abc" }));
    await expect(credGet("k", "win32", exec)).resolves.toBe("abc");
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("powershell.exe");
    // args are a fixed script plus flags; the key/value are passed only via env, never as a
    // distinct argv element (a substring check would false-positive on incidental letters that
    // already appear in the fixed PowerShell/C# script text).
    expect(args).not.toContain("k");
    expect(args).not.toContain("openclaw-duties.k");
    expect(opts?.env?.OCD_TARGET).toBe("openclaw-duties.k");
  });
  it("writes via env vars, keeping the key and value out of argv/script", async () => {
    const exec = mockExec(async () => ({ stdout: "" }));
    await credSet("k", "v", "win32", exec);
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("powershell.exe");
    expect(args).not.toContain("v");
    expect(args).not.toContain("k");
    expect(opts?.env?.OCD_SECRET).toBe("v");
    expect(opts?.env?.OCD_TARGET).toBe("openclaw-duties.k");
  });
});

describe("creds (unsupported platform)", () => {
  it("rejects with a clear error on linux", async () => {
    await expect(
      credGet(
        "k",
        "linux",
        mockExec(async () => ({ stdout: "" })),
      ),
    ).rejects.toThrow("credential store not supported on linux");
  });
});
