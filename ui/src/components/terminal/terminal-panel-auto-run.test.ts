/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { TERMINAL_AUTO_RUN_SENT_EVENT } from "./terminal-panel-session-types.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

const createTerminal = vi.fn(async () =>
  createTerminalController(),
) as unknown as CreateGhosttyTerminalMock;
const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createTerminal);
const COMMAND = "vasudev onboard --skip-daemon --no-install-daemon --skip-ui --skip-health";

type PanelRequest = { method: string; params: unknown };

function createClient(requests: PanelRequest[]): TerminalGatewayClient {
  let openCount = 0;
  return {
    forceReconnect: () => {},
    request: async <T>(method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "terminal.open") {
        openCount += 1;
        return terminalOpenResult(`session-${openCount}`) as T;
      }
      if (method === "terminal.list") {
        return [] as T;
      }
      return { ok: true } as T;
    },
    addEventListener: () => () => {},
  };
}

/** The route's own terminal: a fresh page session with no catalog or session id. */
function createFirstRunPanel(
  requests: PanelRequest[],
  autoRunCommand: string | null,
): OpenClawTerminalPanel {
  const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
  panel.client = createClient(requests);
  panel.available = true;
  panel.page = panel.fullscreen = panel.embedded = true;
  panel.routeTarget = null;
  panel.autoRunCommand = autoRunCommand;
  document.body.append(panel);
  return panel;
}

function inputs(requests: PanelRequest[]): unknown[] {
  return requests
    .filter((request) => request.method === "terminal.input")
    .map(({ params }) => params);
}

async function waitForOpenCount(requests: PanelRequest[], count: number): Promise<void> {
  await waitForFast(() =>
    expect(requests.filter((request) => request.method === "terminal.open")).toHaveLength(count),
  );
}

describe("terminal panel auto-run command", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    vi.mocked(createTerminal).mockClear();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("types the command into the session it opened, once its PTY exists", async () => {
    const requests: PanelRequest[] = [];
    const sent = vi.fn();
    const panel = createFirstRunPanel(requests, COMMAND);
    panel.addEventListener(TERMINAL_AUTO_RUN_SENT_EVENT, sent);

    await waitForOpenCount(requests, 1);
    await waitForFast(() => expect(inputs(requests)).toHaveLength(1));

    expect(inputs(requests)).toEqual([{ sessionId: "session-1", data: `${COMMAND}\n` }]);
    expect(sent).toHaveBeenCalledOnce();
    // The open RPC resolves before the keystrokes reach the Gateway.
    expect(requests.findIndex((request) => request.method === "terminal.input")).toBeGreaterThan(
      requests.findIndex((request) => request.method === "terminal.open"),
    );
  });

  it("never retypes the command for another session in the same panel", async () => {
    const requests: PanelRequest[] = [];
    const panel = createFirstRunPanel(requests, COMMAND);
    await waitForFast(() => expect(inputs(requests)).toHaveLength(1));

    // A second session opened while the marker is still on the route.
    panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")!.click();
    await waitForOpenCount(requests, 2);

    // And a third after the route cleared the marker, as the page does on send.
    panel.autoRunCommand = null;
    await panel.updateComplete;
    panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")!.click();
    await waitForOpenCount(requests, 3);

    expect(inputs(requests)).toEqual([{ sessionId: "session-1", data: `${COMMAND}\n` }]);
  });

  it("types nothing when the route carries no first-run marker", async () => {
    const requests: PanelRequest[] = [];
    const sent = vi.fn();
    const panel = createFirstRunPanel(requests, null);
    panel.addEventListener(TERMINAL_AUTO_RUN_SENT_EVENT, sent);

    await waitForOpenCount(requests, 1);
    await panel.updateComplete;

    expect(inputs(requests)).toEqual([]);
    expect(sent).not.toHaveBeenCalled();
  });
});
