import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { provisionMemberAgent, readBootstrapPending } from "./team-agent.js";

describe("provisionMemberAgent", () => {
  it("creates the agent by name and returns the id and workspace core chose", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      agentId: "ramesh",
      name: "Ramesh",
      workspace: "/home/openclaw/.openclaw/workspace-ramesh",
    }));
    // SAFETY: the test double matches the GatewayRequest shape this function calls.
    const result = await provisionMemberAgent({ request: request as never, name: "Ramesh" });
    expect(request).toHaveBeenCalledWith("agents.create", { name: "Ramesh" });
    expect(result).toEqual({
      agentId: "ramesh",
      workspace: "/home/openclaw/.openclaw/workspace-ramesh",
    });
  });

  it("passes no workspace and no model, so both are inherited", async () => {
    const request = vi.fn(async () => ({ ok: true, agentId: "amit", workspace: "/w/amit" }));
    // SAFETY: as above.
    await provisionMemberAgent({ request: request as never, name: "Amit" });
    const [, params] = request.mock.calls[0] ?? [];
    expect(Object.keys(params ?? {})).toEqual(["name"]);
  });

  it("turns an id collision into a message naming the fix", async () => {
    const request = vi.fn(async () => {
      throw new Error("agent already exists: ramesh");
    });
    await expect(
      // SAFETY: as above.
      provisionMemberAgent({ request: request as never, name: "Ramesh" }),
    ).rejects.toThrow(
      'There is already an agent called "Ramesh" — give this member a different name.',
    );
  });

  it("rejects a reply with no agent id rather than storing a half-made member", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    await expect(
      // SAFETY: as above.
      provisionMemberAgent({ request: request as never, name: "Ramesh" }),
    ).rejects.toThrow("could not create an assistant for Ramesh");
  });
});

describe("readBootstrapPending", () => {
  it("is true while BOOTSTRAP.md is still in the workspace and false once it is gone", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "team-agent-"));
    expect(await readBootstrapPending(dir)).toBe(false);
    await writeFile(path.join(dir, "BOOTSTRAP.md"), "# hatch");
    expect(await readBootstrapPending(dir)).toBe(true);
  });

  it("is false when no workspace was recorded", async () => {
    expect(await readBootstrapPending(undefined)).toBe(false);
  });
});
