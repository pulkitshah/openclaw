import { describe, expect, it } from "vitest";
import { registerTeamTools } from "./tools.js";

type ExecutableTool = {
  execute: (id: string, input: unknown) => Promise<{ content: Array<{ text: string }> }>;
};

type GatewayCall = { method: string; params: Record<string, unknown>; scopes: string[] };

function makeTools(params?: { respond?: (call: GatewayCall) => unknown }) {
  const tools = new Map<string, ExecutableTool>();
  const calls: GatewayCall[] = [];
  const api = {
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      const resolved = tool as ExecutableTool & { name?: string };
      tools.set(resolved.name ?? opts?.name ?? "", resolved);
    },
    runtime: {
      gateway: {
        request: async (
          method: string,
          args: Record<string, unknown>,
          opts: { scopes: string[] },
        ) => {
          const call = { method, params: args, scopes: opts.scopes };
          calls.push(call);
          return params?.respond?.(call) ?? {};
        },
      },
    },
    // SAFETY: this harness only ever receives this plugin's one tool, whose `execute` matches
    // ExecutableTool.
  } as never;
  registerTeamTools({ api });
  const run = async (name: string, input: unknown) =>
    JSON.parse((await tools.get(name)!.execute("c1", input)).content[0]!.text);
  return { run, calls, tools };
}

describe("team_list", () => {
  it("returns names, ids, roles and channel names, never sender ids", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) =>
        method === "team.get"
          ? {
              members: [
                {
                  id: "ramesh",
                  name: "Ramesh",
                  role: "member",
                  addedBy: "owner",
                  addedAt: 1,
                  updatedAt: 1,
                  channels: [{ channel: "whatsapp", senderId: "+919812345678", addedAt: 1 }],
                },
              ],
            }
          : {},
    });
    const out = JSON.stringify(await run("team_list", {}));
    expect(calls[0]).toMatchObject({ method: "team.get", params: {}, scopes: ["operator.read"] });
    expect(out).toContain('"id":"ramesh"');
    expect(out).toContain('"channel":"whatsapp"');
    expect(out).not.toContain("+919812345678");
    expect(out).not.toContain("addedBy");
  });

  it("is registered by name", () => {
    const { tools } = makeTools();
    expect(tools.has("team_list")).toBe(true);
  });
});
