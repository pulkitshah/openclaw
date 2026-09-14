import os from "node:os";
import {
  capturePluginRegistration,
  createCapturedPluginRegistration,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { RENDER_ROUTE_PATH } from "./src/adapters/render.js";

vi.mock("./src/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/store.js")>()),
  DutyStore: {
    open: () => ({ getSettings: async () => ({ owner: { channel: "telegram", target: "999" } }) }),
  },
}));

const runManagerParams = vi.fn();
vi.mock("./src/run-service.js", () => ({
  RunManager: class {
    constructor(params: unknown) {
      runManagerParams(params);
    }
  },
}));

const aiAdapters = vi.fn();
vi.mock("./src/adapters/ai.js", () => ({
  createAiAdapter: (params: unknown) => {
    aiAdapters(params);
    return {};
  },
}));

const askAdapters = vi.fn();
vi.mock("./src/adapters/ask.js", () => ({
  createAskAdapter: (params: unknown) => {
    askAdapters(params);
    return {};
  },
}));

import plugin, { resolveBrowserProfile, resolveRenderBaseUrl } from "./index.js";
import type { RunOrigin } from "./src/store.js";

describe("duties plugin registration", () => {
  it("registers the sidebar tab descriptor", () => {
    const captured = capturePluginRegistration({
      id: "duties",
      name: "Duties",
      register: plugin.register,
    });
    expect(captured.controlUiDescriptors).toContainEqual({
      surface: "tab",
      id: "duties",
      label: "Duties",
      icon: "listChecks",
      group: "control",
      requiredScopes: ["operator.read"],
    });
  });

  it("replays browser steps on the managed profile unless the config names another", () => {
    expect(resolveBrowserProfile(undefined)).toBe("openclaw");
    expect(resolveBrowserProfile({})).toBe("openclaw");
    expect(resolveBrowserProfile({ browserProfile: "  " })).toBe("openclaw");
    expect(resolveBrowserProfile({ browserProfile: 7 })).toBe("openclaw");
    expect(resolveBrowserProfile({ browserProfile: "chrome" })).toBe("chrome");
  });

  it("serves rendered documents to the managed browser on a plugin-authenticated prefix route", () => {
    const captured = createCapturedPluginRegistration({ id: "duties", name: "Duties" });
    const registerHttpRoute = vi.fn();
    captured.api.registerHttpRoute = registerHttpRoute;

    plugin.register(captured.api);

    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: RENDER_ROUTE_PATH,
        match: "prefix",
        auth: "plugin",
        handler: expect.any(Function),
      }),
    );
    expect(RENDER_ROUTE_PATH).toBe("/plugins/duties/render/");
  });

  it("matches the render base url to the scheme the Gateway actually serves", () => {
    // The port comes from resolveGatewayPort, which honours OPENCLAW_GATEWAY_PORT ahead of config,
    // so the assertions pin the scheme and the loopback host without depending on the environment.
    const plain = resolveRenderBaseUrl({ gateway: { port: 19001 } });
    expect(plain).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    // TLS is served on the same port, so only the scheme changes; an http:// URL would fail at the
    // transport and reach the owner as an opaque browser navigation error.
    expect(resolveRenderBaseUrl({ gateway: { port: 19001, tls: { enabled: true } } })).toBe(
      plain.replace("http://", "https://"),
    );
    expect(resolveRenderBaseUrl({ gateway: { port: 19001, tls: { enabled: false } } })).toBe(plain);
    expect(resolveRenderBaseUrl({ gateway: { port: 19001, tls: {} } })).toBe(plain);
    expect(resolveRenderBaseUrl({})).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  // Two regressions in one place. Both adapters were built with a hardcoded sessionKey "main":
  // under `agents.ownership: "explicit"` with more than one agent, "main" has no owner, so every
  // ai and ask step failed with "session key \"main\" has no explicit owner" before it ran. And an
  // `ask` keyed to the run's own origin parked a mail run's approval gate inside the dispatcher's
  // `hook:gmail:*` session, where the owner could neither see nor answer it — so an ask follows
  // the route rule `deliver` uses (the run's chat, else the owner) while `ai`, which no person
  // reads, stays on the run's own session.
  it("runs ai on the run's own session and asks where the owner can answer", async () => {
    const captured = createCapturedPluginRegistration({ id: "duties", name: "Duties" });
    // Evidence blobs and the rendered-file directory are only reachable through the real plugin
    // runtime proxy; this case is about which session the adapters are built with.
    captured.api.runtime.state.openBlobStore = () => ({ register: async () => {} });
    captured.api.runtime.state.resolveStateDir = () => os.tmpdir();
    plugin.register(captured.api);
    const params = runManagerParams.mock.calls.at(-1)?.[0] as {
      deps: (duty: { id: string }, run: { id: string; origin?: RunOrigin }) => Promise<unknown>;
    };

    const sessionKeysFor = async (origin: RunOrigin | undefined) => {
      aiAdapters.mockClear();
      askAdapters.mockClear();
      await params.deps({ id: "d1" }, { id: "r1", ...(origin ? { origin } : {}) });
      return {
        ai: (aiAdapters.mock.calls.at(-1)?.[0] as { sessionKey: string }).sessionKey,
        ask: (askAdapters.mock.calls.at(-1)?.[0] as { sessionKey: string }).sessionKey,
      };
    };

    // A chat run: both act in the conversation the owner started the run from.
    expect(
      await sessionKeysFor({
        kind: "chat",
        sessionKey: "agent:krishna:duties",
        agentId: "krishna",
      }),
    ).toEqual({ ai: "agent:krishna:duties", ask: "agent:krishna:duties" });
    // A mail run: the model call stays with the dispatcher that made it; the question goes to the
    // owner's own session, resolved from the owner target through the host's routing.
    const mail = await sessionKeysFor({ kind: "mail", agentId: "duties-mail" });
    expect(mail.ai).toBe("agent:duties-mail:main");
    expect(mail.ask).not.toBe("agent:duties-mail:main");
    expect(mail.ask).toMatch(/^agent:/u);
    const manual = await sessionKeysFor(undefined);
    expect(manual.ai).toBe("main");
    expect(manual.ask).toBe(mail.ask);
  });
});
