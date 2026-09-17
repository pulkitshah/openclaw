// Shared fixture for gateway-methods.test.ts: an in-memory DutyStore wired to the registered
// Gateway methods, plus a `call` that resolves whatever a handler responded.
import { tmpdir } from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { vi, type Mock } from "vitest";
import type { RenderAdapter } from "./adapters/render.js";
import type { DeskHealth } from "./desk.js";
import { registerDutiesGatewayMethods } from "./gateway-methods.js";
import { DutyStore } from "./store.js";

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
  hasCurrentClientAuthority?: () => boolean;
  /** Only the connection metadata the handlers read: the scope list `holdsAdminScope` checks. */
  client?: { connect: { scopes?: string[] } };
}) => Promise<void>;

export type EmitFn = (name: "changed" | "run", payload: Record<string, unknown>) => void;

export function harness(params?: {
  emit?: Mock<EmitFn>;
  runs?: {
    start: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    waitFor: ReturnType<typeof vi.fn>;
    status?: ReturnType<typeof vi.fn>;
    admit?: ReturnType<typeof vi.fn>;
  };
  blob?: { bytes: Uint8Array; metadata: { contentType: string } };
  config?: OpenClawConfig;
  render?: RenderAdapter;
  previewDir?: string;
  notifyOwner?: (text: string) => Promise<void>;
  deskHealth?: () => Promise<DeskHealth>;
}) {
  const methods = new Map<string, { handler: Handler; scope: string }>();
  const api = {
    registerGatewayMethod: (name: string, handler: never, opts: { scope: string }) =>
      methods.set(name, { handler, scope: opts.scope }),
    config: params?.config ?? {},
    // SAFETY: the Gateway methods under test only touch `registerGatewayMethod` and `config`.
  } as never;
  const store = new DutyStore({
    duties: memoryKeyed() as never,
    runs: memoryKeyed() as never,
    creds: memoryKeyed() as never,
    templates: memoryKeyed() as never,
    brands: memoryKeyed() as never,
    settings: memoryKeyed() as never,
  });
  const emit = params?.emit ?? vi.fn<EmitFn>();
  const runs = params?.runs ?? {
    start: vi.fn(),
    cancel: vi.fn(),
    waitFor: vi.fn(),
    status: vi.fn(() => ({ active: 0, queued: 0 })),
    admit: vi.fn(),
  };
  const creds = {
    set: vi.fn<(key: string, value: string) => Promise<void>>(async () => {}),
    delete: vi.fn<(key: string) => Promise<boolean>>(async () => true),
    has: vi.fn<(key: string) => Promise<boolean>>(async (key) => key === "acme-demo.password"),
  };
  registerDutiesGatewayMethods({
    api,
    store,
    runs: runs as never,
    emit,
    creds,
    evidence: () => ({ lookup: async () => params?.blob }),
    render: params?.render ?? {
      toPdf: async () => {
        throw new Error("render not expected");
      },
    },
    previewDir: async () => params?.previewDir ?? tmpdir(),
    ...(params?.notifyOwner ? { notifyOwner: params.notifyOwner } : {}),
    ...(params?.deskHealth ? { deskHealth: params.deskHealth } : {}),
  });

  /** `scopes` is what the connection holds, as the Gateway hands it to a handler; omitted means a
   *  caller whose scopes cannot be read, which `holdsAdminScope` treats as not admin. */
  const call = async (
    name: string,
    callParams: Record<string, unknown>,
    callOpts?: { hasCurrentClientAuthority?: () => boolean; scopes?: string[] },
  ) =>
    new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) => {
      void methods.get(name)!.handler({
        params: callParams,
        respond: (ok, result, error) => resolve({ ok, result, error }),
        ...(callOpts?.hasCurrentClientAuthority
          ? { hasCurrentClientAuthority: callOpts.hasCurrentClientAuthority }
          : {}),
        ...(callOpts?.scopes ? { client: { connect: { scopes: callOpts.scopes } } } : {}),
      });
    });
  const asAdmin = { scopes: ["operator.admin"] };

  return { methods, store, emit, runs, creds, call, asAdmin };
}
