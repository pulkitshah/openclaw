import os from "node:os";
import {
  capturePluginRegistration,
  createCapturedPluginRegistration,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { RENDER_ROUTE_PATH } from "./src/adapters/render.js";

/** The owner target as the store would hold it. Mutable so one case can prove a fresh install —
 *  where no owner has been set on the Duties page yet — still runs a Duty that has no `ask`. */
let storedOwner: { channel: string; target: string } | undefined = {
  channel: "telegram",
  target: "999",
};
vi.mock("./src/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./src/store.js")>()),
  DutyStore: {
    // `ownerMember` is undefined here on purpose: this suite predates the Team roster and tests
    // the pre-Team fallback path (`ownerTarget` reading `settings.owner` directly), which is
    // still real behavior for a desk with no Team member yet.
    open: () => ({
      getSettings: async () => ({ owner: storedOwner }),
      ownerMember: async () => undefined,
    }),
  },
}));

const runManagerParams = vi.fn();
vi.mock("./src/run-service.js", () => ({
  RunManager: function RunManager(params: unknown) {
    runManagerParams(params);
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

  // The defect that forced the tools to become clients: the host loads this plugin a SECOND time
  // in `tool-discovery` mode to list and run its tools, and `register()` runs again there. Every
  // runtime thing below the tools is a single-owner resource — the render server's one-time token
  // map, the RunManager, the events service — so a second copy is a competing owner, not a
  // duplicate. Live, that meant tool renders 404'd (published in one copy, served by the other)
  // and tool-started runs were invisible to cancel, events and orphan recovery.
  it("registers only the tools in tool-discovery mode, and no runtime state", () => {
    const captured = createCapturedPluginRegistration({
      id: "duties",
      name: "Duties",
      registrationMode: "tool-discovery",
    });
    const registerHttpRoute = vi.fn();
    const registerService = vi.fn();
    const registerGatewayMethod = vi.fn();
    const registerCli = vi.fn();
    const registerTool = vi.fn();
    captured.api.registerHttpRoute = registerHttpRoute;
    captured.api.registerService = registerService;
    captured.api.registerGatewayMethod = registerGatewayMethod;
    captured.api.registerCli = registerCli;
    captured.api.registerTool = registerTool;
    // Opening the store or the blob store would throw through the captured runtime; the point of
    // this case is that nothing here reaches for either.
    captured.api.runtime.state.openBlobStore = () => {
      throw new Error("tool-discovery must not open the blob store");
    };
    captured.api.runtime.state.resolveStateDir = () => {
      throw new Error("tool-discovery must not resolve a state dir");
    };

    plugin.register(captured.api);

    expect(registerTool).toHaveBeenCalled();
    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
    expect(registerGatewayMethod).not.toHaveBeenCalled();
    expect(registerCli).not.toHaveBeenCalled();
    expect(captured.controlUiDescriptors).toHaveLength(0);
  });

  it("registers only CLI descriptors in cli-metadata mode", () => {
    const captured = createCapturedPluginRegistration({
      id: "duties",
      name: "Duties",
      registrationMode: "cli-metadata",
    });
    const registerCli = vi.fn();
    const registerTool = vi.fn();
    const registerService = vi.fn();
    captured.api.registerCli = registerCli;
    captured.api.registerTool = registerTool;
    captured.api.registerService = registerService;
    // No runtime stub here on purpose: in this mode the host makes `api.runtime` throw on any
    // access, so registering without touching it is exactly what is being proved.

    plugin.register(captured.api);

    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli.mock.calls[0]?.[1]).toMatchObject({
      descriptors: [{ name: "duties", hasSubcommands: true }],
    });
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerService).not.toHaveBeenCalled();
  });

  // Two regressions in one place. Both adapters were built with a hardcoded sessionKey "main":
  // under `agents.ownership: "explicit"` with more than one agent, "main" has no owner, so every
  // ai and ask step failed with "session key \"main\" has no explicit owner" before it ran. And an
  // `ask` keyed to the run's own origin parked a mail run's approval gate inside the dispatcher's
  // `hook:gmail:*` session, where the owner could neither see nor answer it — so an ask is raised
  // where the OWNER can answer it while `ai`, which no person reads, stays on the run's own
  // session.
  it("runs ai on the run's own session and asks where the owner can answer", async () => {
    const { sessionKeysFor } = registerForDeps();

    // A chat run that is not provably the owner's own direct chat asks the owner, not the chat:
    // a tap on a question card is gated only by who can see the message.
    const chat = await sessionKeysFor({
      kind: "chat",
      sessionKey: "agent:krishna:duties",
      agentId: "krishna",
    });
    expect(chat.ai).toBe("agent:krishna:duties");
    expect(chat.ask).not.toBe("agent:krishna:duties");
    // A mail run: the model call stays with the dispatcher that made it; the question goes to the
    // owner's own session, resolved from the owner target through the host's routing.
    const mail = await sessionKeysFor({ kind: "mail", agentId: "duties-mail" });
    expect(mail.ai).toBe("agent:duties-mail:main");
    expect(mail.ask).not.toBe("agent:duties-mail:main");
    expect(mail.ask).toMatch(/^agent:/u);
    const manual = await sessionKeysFor(undefined);
    expect(manual.ai).toBe("main");
    expect(manual.ask).toBe(mail.ask);
    expect(chat.ask).toBe(mail.ask);
  });

  // Regression: `deps()` is built for EVERY run and resolved the ask session eagerly, so on a
  // fresh install — where the owner target is set by hand on the Duties page — pressing Run failed
  // every Duty with "no owner target configured" before step 1, including Duties with no `ask`
  // and no `deliver` at all.
  it("builds a run's deps with no owner target configured, and only fails when an ask is reached", async () => {
    storedOwner = undefined;
    try {
      const { deps, askSessionKey } = registerForDeps();
      const built = await deps({ id: "d1" }, { id: "r1" });
      expect(built).toBeTruthy();
      // The owner is needed only when the run actually raises a question.
      await expect(askSessionKey()).rejects.toThrow(/no owner target configured/u);
    } finally {
      storedOwner = { channel: "telegram", target: "999" };
    }
  });
});

/** Registers the plugin and exposes the RunManager `deps` factory plus the session keys the ai and
 *  ask adapters are built with. The ask session arrives as a resolver, not a string, so it is
 *  called here the way the ask adapter calls it — inside the ask, not while building deps. */
function registerForDeps() {
  const captured = createCapturedPluginRegistration({ id: "duties", name: "Duties" });
  // Evidence blobs and the rendered-file directory are only reachable through the real plugin
  // runtime proxy; these cases are about how the adapters are built.
  captured.api.runtime.state.openBlobStore = () => ({
    register: async () => {},
    registerIfAbsent: async () => false,
    lookup: async () => undefined,
    entries: async () => [],
    delete: async () => false,
    deleteExpiredKey: async () => undefined,
    deleteExpired: async () => [],
    clear: async () => {},
  });
  captured.api.runtime.state.resolveStateDir = () => os.tmpdir();
  plugin.register(captured.api);
  const params = runManagerParams.mock.calls.at(-1)?.[0] as {
    deps: (duty: { id: string }, run: { id: string; origin?: RunOrigin }) => Promise<unknown>;
  };
  const askSessionKey = async () => {
    const built = askAdapters.mock.calls.at(-1)?.[0] as {
      sessionKey: string | (() => Promise<string>);
    };
    return typeof built.sessionKey === "string" ? built.sessionKey : await built.sessionKey();
  };
  return {
    deps: params.deps,
    askSessionKey,
    sessionKeysFor: async (origin: RunOrigin | undefined) => {
      aiAdapters.mockClear();
      askAdapters.mockClear();
      await params.deps({ id: "d1" }, { id: "r1", ...(origin ? { origin } : {}) });
      return {
        ai: (aiAdapters.mock.calls.at(-1)?.[0] as { sessionKey: string } | undefined)?.sessionKey,
        ask: await askSessionKey(),
      };
    },
  };
}
