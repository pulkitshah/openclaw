import { describe, expect, it, vi } from "vitest";
import { credGet, credHas, credSet } from "./creds.js";

describe("creds (macOS)", () => {
  it("reads through `security find-generic-password -w` with a namespaced service", async () => {
    const exec = vi.fn(async () => ({ stdout: "s3cret\n" }));
    await expect(credGet("amigos.password", "darwin", exec)).resolves.toBe("s3cret");
    expect(exec).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "openclaw-duties.amigos.password", "-w"],
      undefined,
    );
  });
  it("never puts the value on argv when saving; it goes via stdin", async () => {
    const exec = vi.fn(async () => ({ stdout: "" }));
    await credSet("amigos.password", "s3cret", "darwin", exec);
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("security");
    expect(args.join(" ")).not.toContain("s3cret");
    expect(opts?.input).toContain("s3cret");
  });
  it("maps a missing item to a plain error without echoing security's stderr", async () => {
    const exec = vi.fn(async () => {
      throw new Error("security: SecKeychainSearchCopyNext: openclaw-duties.x");
    });
    await expect(credGet("x", "darwin", exec)).rejects.toThrow("no credential stored for x");
    await expect(credHas("x", "darwin", exec)).resolves.toBe(false);
  });
  it("rejects malformed keys", async () => {
    await expect(credGet("Bad Key!", "darwin", vi.fn())).rejects.toThrow("invalid credential key");
  });
});
