import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { registerDutyTools } from "./tools.js";

type ExecutableTool = {
  execute: (
    id: string,
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }> }>;
};

type GatewayCall = { method: string; params: Record<string, unknown>; scopes: string[] };

/** Mirrors the host's own `registerTool`: a factory is invoked once with the turn's tool context
 *  (`src/plugins/registry-registrars-tools-hooks.ts:225`), a static tool is used as-is.
 *
 *  The tools own no state, so the only surfaces they touch are `registerTool` and
 *  `runtime.gateway.request`. That is the point of the contract these cases pin: a tool must be a
 *  client of this plugin's Gateway methods, because the host loads a second copy of the plugin in
 *  `tool-discovery` mode and any state a tool owned would be a competing owner. */
function makeTools(params?: {
  ctx?: OpenClawPluginToolContext;
  respond?: (call: GatewayCall) => unknown;
}) {
  const tools = new Map<string, ExecutableTool>();
  const calls: GatewayCall[] = [];
  const api = {
    registerTool: (tool: unknown, opts?: { name?: string }) => {
      // SAFETY: this harness only ever receives this plugin's own tools and factories, whose
      // `execute` matches ExecutableTool; `opts.name` is the factory's declared name.
      const resolved = (typeof tool === "function" ? tool(params?.ctx ?? {}) : tool) as
        | (ExecutableTool & { name?: string })
        | null;
      if (!resolved) {
        return;
      }
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
  } as never;
  registerDutyTools({ api });
  const run = async (name: string, input: unknown, signal?: AbortSignal) =>
    JSON.parse((await tools.get(name)!.execute("c1", input, signal)).content[0]!.text);
  return { run, calls, tools };
}

describe("duty tools as gateway clients", () => {
  it("forwards each read and write to the method that owns it, with the narrowest scope", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) => {
        if (method === "duties.list") {
          return { duties: [{ id: "d1", name: "D", status: "building", summary: "s" }] };
        }
        if (method === "duties.get") {
          return { duty: { id: "d1" }, runs: [] };
        }
        if (method === "duties.cred.has") {
          return { stored: true };
        }
        if (method === "duties.template.list") {
          return { templates: [{ id: "t1" }] };
        }
        return { ok: true };
      },
    });

    expect((await run("duty_list", {})).duties[0]).toMatchObject({ id: "d1", status: "building" });
    await run("duty_get", { id: "d1" });
    await run("duty_draft", { id: "d1", name: "D", summary: "s" });
    await run("duty_set_steps", { id: "d1", steps: [] });
    await run("duty_save", { id: "d1" });
    expect((await run("cred_needed", { key: "acme-demo.password", reason: "login" })).stored).toBe(
      true,
    );
    await run("template_list", {});
    await run("template_get", { id: "t1" });
    await run("template_set", { template: { id: "t1" } });
    await run("brand_get", {});
    await run("brand_set", { brand: { name: "B" } });

    expect(calls.map((c) => `${c.method} ${c.scopes[0]}`)).toEqual([
      "duties.list operator.read",
      "duties.get operator.read",
      "duties.draft operator.write",
      "duties.steps operator.write",
      "duties.status operator.write",
      "duties.cred.has operator.read",
      "duties.template.list operator.read",
      "duties.template.get operator.read",
      "duties.template.set operator.write",
      "duties.brand.get operator.read",
      "duties.brand.set operator.write",
    ]);
    // `duty_save` means "make it active"; the tool must not invent a different status.
    expect(calls.find((c) => c.method === "duties.status")?.params).toEqual({
      id: "d1",
      status: "active",
    });
  });

  it("team_list returns names, ids, roles and channel names, never sender ids", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) =>
        method === "duties.team.get"
          ? {
              members: [
                {
                  id: "ramesh",
                  name: "Ramesh",
                  role: "member",
                  agentId: "ramesh",
                  agentWorkspace: "/w/ramesh",
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
    expect(calls[0]).toMatchObject({
      method: "duties.team.get",
      params: {},
      scopes: ["operator.read"],
    });
    expect(out).toContain('"id":"ramesh"');
    expect(out).toContain('"channel":"whatsapp"');
    expect(out).not.toContain("+919812345678");
    expect(out).not.toContain("agentWorkspace");
  });

  it("renders a preview through the gateway and returns the path the owner can be shown", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) =>
        method === "duties.template.render" ? { path: "/p/flight-options.pdf", bytes: 9 } : {},
    });
    expect(await run("template_preview", { id: "flight-options", data: { route: "IXU" } })).toEqual(
      {
        path: "/p/flight-options.pdf",
      },
    );
    expect(calls[0]).toMatchObject({
      method: "duties.template.render",
      params: { id: "flight-options", data: { route: "IXU" } },
      // A render drives the managed browser, opens a tab and writes a file: not a read.
      scopes: ["operator.write"],
    });
  });

  it("starts a run then polls run.wait until it is terminal, carrying the turn's origin", async () => {
    let waits = 0;
    const { run, calls } = makeTools({
      ctx: {
        sessionKey: "agent:krishna:duties-p2",
        agentId: "krishna",
        messageChannel: "telegram",
      },
      respond: ({ method }) => {
        if (method === "duties.run") {
          return { runId: "r1", queued: false };
        }
        if (method === "duties.run.wait") {
          waits += 1;
          // Still going on the first poll, terminal on the second.
          return {
            run:
              waits < 2
                ? { id: "r1", status: "needs_input" }
                : { id: "r1", status: "ok", outputs: { a: 1 } },
          };
        }
        return {};
      },
    });

    const result = await run("duty_run", { id: "d1", inputs: { mail: {} }, keepOpen: true });
    expect(result).toMatchObject({ status: "ok", outputs: { a: 1 } });
    expect(waits).toBe(2);
    expect(calls[0]).toMatchObject({
      method: "duties.run",
      params: {
        id: "d1",
        keepOpen: true,
        origin: {
          kind: "chat",
          sessionKey: "agent:krishna:duties-p2",
          agentId: "krishna",
          channel: "telegram",
        },
      },
    });
  });

  it("reports the run's own errors instead of polling a run that was never started", async () => {
    const { run, calls } = makeTools({
      respond: ({ method }) =>
        method === "duties.run" ? { ok: false, errors: ['input "mail" is required'] } : {},
    });
    expect(await run("duty_run", { id: "d1" })).toEqual({
      ok: false,
      errors: ['input "mail" is required'],
    });
    expect(calls.some((c) => c.method === "duties.run.wait")).toBe(false);
  });

  it("cancels through the gateway when the tool call is aborted", async () => {
    const controller = new AbortController();
    const { run, calls } = makeTools({
      respond: ({ method }) => {
        if (method === "duties.run") {
          return { runId: "r1", queued: false };
        }
        if (method === "duties.run.wait") {
          // Never terminal: the run is parked, exactly as on a real owner question.
          controller.abort();
          return { run: { id: "r1", status: "needs_input" } };
        }
        return {};
      },
    });
    expect(await run("duty_run", { id: "d1" }, controller.signal)).toMatchObject({
      ok: false,
      runId: "r1",
      status: "cancelled",
    });
    expect(calls.find((c) => c.method === "duties.run.cancel")?.params).toEqual({ runId: "r1" });
  });

  it("marks a run from the mail dispatcher as mail-origin, and a bare turn as manual", async () => {
    const origin = async (ctx: OpenClawPluginToolContext) => {
      const { run, calls } = makeTools({
        ctx,
        respond: ({ method }) =>
          method === "duties.run" ? { runId: "r1" } : { run: { id: "r1", status: "ok" } },
      });
      await run("duty_run", { id: "d1" });
      return (calls[0]?.params as { origin: { kind: string } } | undefined)?.origin;
    };
    expect(await origin({ agentId: "duties-mail", sessionKey: "hook:gmail:1" })).toMatchObject({
      kind: "mail",
      agentId: "duties-mail",
    });
    expect(await origin({})).toEqual({ kind: "manual" });
  });

  it("registers every declared tool", () => {
    const { tools } = makeTools();
    expect([...tools.keys()].toSorted()).toEqual(
      [
        "brand_get",
        "brand_set",
        "cred_needed",
        "duty_draft",
        "duty_get",
        "duty_list",
        "duty_run",
        "duty_save",
        "duty_set_steps",
        "team_list",
        "template_get",
        "template_list",
        "template_preview",
        "template_set",
      ].toSorted(),
    );
  });
});

// A guard against the defect that started this: the tools may not be given anything else to own.
it("registerDutyTools takes only the plugin api", () => {
  expect(registerDutyTools.length).toBe(1);
  expect(vi.isMockFunction(registerDutyTools)).toBe(false);
});
