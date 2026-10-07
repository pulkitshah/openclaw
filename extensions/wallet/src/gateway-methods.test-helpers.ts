// Shared fixture for gateway-methods.test.ts: an in-memory WalletStore wired to the registered
// Gateway methods, plus a `call` that resolves whatever a handler responded.
import { vi } from "vitest";
import { registerWalletGatewayMethods } from "./gateway-methods.js";
import { DEFAULT_RATE_CARD } from "./money.js";
import { createNotices } from "./notices.js";
import { memoryStore } from "./store.test-helpers.js";

type Handler = (ctx: {
  params: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
  client?: {
    connect: { scopes?: string[] };
    authenticatedUserProfile?: { profileId: string };
  };
}) => Promise<void>;

export function harness(opts?: {
  request?: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
}) {
  const methods = new Map<string, { handler: Handler; scope: string }>();
  const api = {
    registerGatewayMethod: (name: string, handler: never, opts: { scope: string }) =>
      methods.set(name, { handler, scope: opts.scope }),
    logger: { warn: () => {} },
    // SAFETY: the Gateway methods under test only touch `registerGatewayMethod` and `logger`.
  } as never;
  const store = memoryStore();
  const emit = vi.fn<(name: "changed", payload: Record<string, unknown>) => void>();
  const send = vi.fn<(text: string) => Promise<void>>(async () => {});
  const counters = { unrecorded: 0 };
  const notices = createNotices({ store, contact: () => "Test Contact", send });
  registerWalletGatewayMethods({
    api,
    store,
    rateCard: () => DEFAULT_RATE_CARD,
    contact: () => "Test Contact",
    notices,
    events: { emit },
    counters,
    request: opts?.request ?? (async () => ({ sessions: [] }) as never),
    lookups: {
      memberName: async () => undefined,
      groupName: async () => undefined,
      mailAgentIds: () => [],
    },
  });
  const call = (
    name: string,
    params: Record<string, unknown> = {},
    opts?: { scopes?: string[]; profileId?: string },
  ) =>
    new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) => {
      void methods.get(name)!.handler({
        params,
        respond: (ok, result, error) => resolve({ ok, result, error }),
        client: {
          connect: { scopes: opts?.scopes ?? ["operator.admin"] },
          ...(opts?.profileId ? { authenticatedUserProfile: { profileId: opts.profileId } } : {}),
        },
      });
    });
  return { methods, store, emit, send, counters, call };
}
