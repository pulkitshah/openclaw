// Covers the ghostty-web 0.4.0 quirks createIsolatedGhosttyTerminal papers over for a
// terminal that lives inside the panel's shadow root.
import type {
  CreateGhosttyTerminalOptions,
  GhosttyTerminalController,
} from "@openclaw/libterminal/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalController } from "./terminal-panel.test-support.ts";
import { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";

const runtimeMocks = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(),
}));

vi.mock("@openclaw/libterminal/browser", () => ({
  createGhosttyTerminal: runtimeMocks.create,
  loadGhosttyRuntime: runtimeMocks.load,
}));
vi.mock("ghostty-web", () => ({
  mockedGhosttyModule: true,
  UrlRegexProvider: class {
    dispose = vi.fn();
  },
}));

class MeasurementAddon {
  activate = vi.fn();
  proposeDimensions = vi.fn();
  dispose = vi.fn();
}

describe("createIsolatedGhosttyTerminal selection inside a shadow root", () => {
  let ghosttyMouseDown: ((event: Event) => void) | undefined;

  beforeEach(() => {
    runtimeMocks.load.mockResolvedValue({ FitAddon: MeasurementAddon });
  });

  afterEach(() => {
    if (ghosttyMouseDown) {
      document.removeEventListener("mousedown", ghosttyMouseDown);
    }
    document.body.replaceChildren();
    runtimeMocks.create.mockReset();
    runtimeMocks.load.mockReset();
  });

  // ghostty-web 0.4.0 records the document-level mousedown target and clears the selection on
  // any click whose document-level target is outside its canvas. A shadow root retargets both to
  // the host, so every drag-selection was wiped by its own click (text still reached the
  // clipboard, the highlight vanished — observed live 2026-10-16). The runtime re-records the
  // composed target so ghostty sees the click as its own.
  it("re-records a canvas mousedown that the shadow root retargeted to the host", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    const parent = host.attachShadow({ mode: "open" }).appendChild(document.createElement("div"));
    const canvas = parent.appendChild(document.createElement("canvas"));
    const controller = createTerminalController();
    const selectionManager = controller.terminal.selectionManager;
    // ghostty's own listener, registered when the terminal opened (before the runtime's).
    ghosttyMouseDown = (event) => {
      selectionManager.mouseDownTarget = event.target;
    };
    document.addEventListener("mousedown", ghosttyMouseDown);
    runtimeMocks.create.mockResolvedValue(controller as unknown as GhosttyTerminalController);
    const created = await createIsolatedGhosttyTerminal({
      parent,
      autoFit: false,
    } as CreateGhosttyTerminalOptions);

    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    expect(selectionManager.mouseDownTarget).toBe(canvas);

    created.dispose();
    canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, composed: true }));
    expect(selectionManager.mouseDownTarget).toBe(host);
  });
});
