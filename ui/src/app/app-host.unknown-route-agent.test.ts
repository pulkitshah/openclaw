/* @vitest-environment jsdom */
// A deep session path can name an agent the connected desk does not have: a
// bookmark, a shared link, or a path a tab kept while signing in to a different
// customer's desk behind the shared front door (deploy/desk/front-door).
import type { RouteLocation } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-routes.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import type { ApplicationContext } from "./context.ts";
import "./app-host.ts";

type UnknownAgentShell = {
  runtime: { context: ApplicationContext };
  activeSessionKey: string;
  routeState: { routeId?: RouteId; location?: RouteLocation };
  recoverUnknownRouteAgent: () => void;
};

const PHANTOM_SESSION_KEY = "agent:prabhat:dashboard:0f3b6c2e";
const PHANTOM_PATHNAME = "/chat/prabhat/dashboard/0f3b6c2e";

function createShell(params: {
  agentIds: string[];
  agentsListCached?: boolean;
  activeSessionKey?: string;
  pathname?: string;
  selectedId?: string;
}) {
  const replace = vi.fn();
  const setSessionKey = vi.fn();
  const shell = document.createElement("openclaw-app-shell") as unknown as UnknownAgentShell;
  shell.runtime = {
    context: {
      basePath: "",
      chatAttachmentHandoff: createChatAttachmentHandoff(),
      agents: {
        state: {
          agentsListCached: params.agentsListCached ?? false,
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            agents: params.agentIds.map((id) => ({ id })),
          },
        },
      },
      agentSelection: { set: vi.fn(), state: { selectedId: params.selectedId ?? "main" } },
      gateway: { setSessionKey, snapshot: { client: null, hello: null, phase: "connected" } },
      sessions: {
        deletionState: () => undefined,
        state: { deletedSessions: [], result: { sessions: [] } },
      },
      replace,
    } as unknown as ApplicationContext,
  };
  shell.activeSessionKey = params.activeSessionKey ?? PHANTOM_SESSION_KEY;
  shell.routeState = {
    routeId: "chat",
    location: { pathname: params.pathname ?? PHANTOM_PATHNAME, search: "", hash: "" },
  };
  return { replace, setSessionKey, shell };
}

afterEach(() => {
  document.body.replaceChildren();
  resetAppHostTestGlobals();
});

describe("Vasudev shell unknown-route-agent recovery", () => {
  it("lands a path for an agent this desk does not have on the default agent instead", () => {
    const { shell, replace, setSessionKey } = createShell({ agentIds: ["main"] });

    shell.recoverUnknownRouteAgent();

    expect(replace).toHaveBeenCalledTimes(1);
    const [routeId, options] = replace.mock.calls[0] as [string, { pathname?: string }];
    expect(routeId).toBe("chat");
    expect(options.pathname).not.toContain("prabhat");
    expect(shell.activeSessionKey).toBe("agent:main:main");
    expect(setSessionKey).toHaveBeenCalledWith("agent:main:main");
  });

  it("leaves a path alone once the desk reports that agent", () => {
    const { shell, replace } = createShell({ agentIds: ["main", "prabhat"] });

    shell.recoverUnknownRouteAgent();

    expect(replace).not.toHaveBeenCalled();
    expect(shell.activeSessionKey).toBe(PHANTOM_SESSION_KEY);
  });

  it("does not retire a route on the previous desk's cached roster", () => {
    const { shell, replace } = createShell({ agentIds: ["main"], agentsListCached: true });

    shell.recoverUnknownRouteAgent();

    expect(replace).not.toHaveBeenCalled();
    expect(shell.activeSessionKey).toBe(PHANTOM_SESSION_KEY);
  });

  it("keeps the route when no known agent could replace it", () => {
    const { shell, replace } = createShell({
      agentIds: ["main"],
      activeSessionKey: "agent:prabhat:main",
      pathname: "/chat/prabhat",
      selectedId: "prasthan",
    });

    shell.recoverUnknownRouteAgent();

    expect(replace).not.toHaveBeenCalled();
  });
});
