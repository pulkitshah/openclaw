import { describe, expect, it } from "vitest";
import { registerLegacyTeamExport } from "./legacy-team-export.js";

function memoryKeyed<T>() {
  const m = new Map<string, T>();
  return {
    register: async (k: string, v: T) => {
      m.set(k, v);
    },
    lookup: async (k: string) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value })),
    delete: async (k: string) => m.delete(k),
  };
}

type Handler = (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
}) => Promise<void>;

/** `registerLegacyTeamExport` opens its keyed store lazily on first call (not during
 *  registration), so this harness never needs to fake the full trusted-plugin-runtime proxy — a
 *  plain map-backed store is enough, matching `gateway-methods.test-helpers.ts`'s own fixture. */
function harness(seed: Array<[string, Record<string, unknown>]> = []) {
  const methods = new Map<string, Handler>();
  const store = memoryKeyed<Record<string, unknown>>();
  const api = {
    registerGatewayMethod: (name: string, handler: Handler) => methods.set(name, handler),
    runtime: { state: { openKeyedStore: () => store } },
    // SAFETY: `registerLegacyTeamExport` only touches `registerGatewayMethod` and
    // `runtime.state.openKeyedStore`.
  } as never;
  registerLegacyTeamExport({ api });
  const call = async (name: string, params: Record<string, unknown> = {}) =>
    new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) => {
      void methods.get(name)!({
        params,
        respond: (ok, result, error) => resolve({ ok, result, error }),
      });
    });
  return {
    call,
    store,
    seed: async () => {
      for (const [key, value] of seed) {
        await store.register(key, value);
      }
    },
  };
}

describe("registerLegacyTeamExport", () => {
  it("exports whatever rows are stored, whole, without interpreting them", async () => {
    const owner = { id: "owner", name: "Pulkit", role: "owner", agentId: "krishna" };
    const { call, seed } = harness([["owner", owner]]);
    await seed();
    const result = await call("duties.legacyTeam.export");
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ members: [owner] });
  });

  it("answers an empty list when there is nothing to migrate", async () => {
    const { call } = harness();
    const result = await call("duties.legacyTeam.export");
    expect(result.result).toEqual({ members: [] });
  });

  it("clear deletes exactly the named ids and reports how many", async () => {
    const { call, store, seed } = harness([
      ["owner", { id: "owner" }],
      ["ramesh", { id: "ramesh" }],
    ]);
    await seed();
    const result = await call("duties.legacyTeam.clear", { ids: ["ramesh"] });
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ cleared: 1 });
    expect((await store.entries()).map((e) => e.key)).toEqual(["owner"]);
  });

  it("registers both methods at operator.admin", async () => {
    const registered: Array<{ name: string; scope: string }> = [];
    const api = {
      registerGatewayMethod: (name: string, _handler: unknown, opts: { scope: string }) =>
        registered.push({ name, scope: opts.scope }),
      runtime: { state: { openKeyedStore: () => memoryKeyed() } },
    } as never;
    registerLegacyTeamExport({ api });
    expect(registered).toEqual([
      { name: "duties.legacyTeam.export", scope: "operator.admin" },
      { name: "duties.legacyTeam.clear", scope: "operator.admin" },
    ]);
  });
});
