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

// A buffer whose rows soft-wrap at `cols`: `wrapped[y]` is ghostty's row flag, "this row continues
// on the next one". A sign-in URL printed by a CLI spans several such rows.
function fakeBuffer(rows: string[], wrapped: boolean[], cols: number) {
  return {
    active: {
      getLine: (y: number) =>
        rows[y] === undefined
          ? undefined
          : {
              length: cols,
              isWrapped: wrapped[y] ?? false,
              translateToString: (trimRight = false, start = 0, end = cols) => {
                const text = rows[y].padEnd(cols).slice(start, end);
                return trimRight ? text.trimEnd() : text;
              },
            },
    },
  };
}

describe("createIsolatedGhosttyTerminal wrapped rows", () => {
  beforeEach(() => {
    runtimeMocks.load.mockResolvedValue({ FitAddon: MeasurementAddon });
  });

  afterEach(() => {
    document.body.replaceChildren();
    runtimeMocks.create.mockReset();
    runtimeMocks.load.mockReset();
  });

  async function createWithBuffer(
    rows: string[],
    wrapped: boolean[],
    cols: number,
    prepare?: (controller: ReturnType<typeof createTerminalController>) => void,
  ) {
    const controller = createTerminalController();
    prepare?.(controller);
    const providers: Array<{
      provideLinks: (
        y: number,
        cb: (links: Array<{ text: string; range: unknown }> | undefined) => void,
      ) => void;
    }> = [];
    Object.assign(controller.terminal, {
      cols,
      buffer: fakeBuffer(rows, wrapped, cols),
      registerLinkProvider: (provider: (typeof providers)[number]) => providers.push(provider),
    });
    runtimeMocks.create.mockResolvedValue(controller as unknown as GhosttyTerminalController);
    const parent = document.body.appendChild(document.createElement("div"));
    await createIsolatedGhosttyTerminal({ parent, autoFit: false } as CreateGhosttyTerminalOptions);
    const links = (y: number) => {
      let found: Array<{ text: string; range: unknown }> | undefined;
      providers[0]?.provideLinks(y, (result) => {
        found = result;
      });
      return found;
    };
    return { controller, links };
  }

  // ghostty-web's UrlRegexProvider reads one row, so a URL wrapped across rows (every OAuth
  // sign-in link a CLI prints) was never clickable; the runtime's provider joins the soft-wrapped
  // rows first and reports one link spanning them, from whichever of its rows is asked.
  it("detects a URL that soft-wraps across rows as one link", async () => {
    const { links } = await createWithBuffer(
      ["https://example.com/", "abc/def?x=1 tail", "plain"],
      [true, false, false],
      20,
    );
    const expected = {
      text: "https://example.com/abc/def?x=1",
      range: { start: { x: 0, y: 0 }, end: { x: 10, y: 1 } },
    };
    expect(links(0)).toMatchObject([expected]);
    expect(links(1)).toMatchObject([expected]);
    expect(links(2)).toBeUndefined();
  });

  // Copy-on-select joined rows with newlines, so the same URL pasted as three lines.
  it("copies a selection across soft-wrapped rows without line breaks", async () => {
    const { controller } = await createWithBuffer(
      ["https://example.com/", "abc/def?x=1", "second line"],
      [true, false, false],
      20,
    );
    const selectionManager = controller.terminal.selectionManager as unknown as {
      selectionStart: { col: number; absoluteRow: number } | null;
      selectionEnd: { col: number; absoluteRow: number } | null;
      getSelection: () => string;
    };
    selectionManager.selectionStart = { col: 0, absoluteRow: 0 };
    selectionManager.selectionEnd = { col: 5, absoluteRow: 2 };
    expect(selectionManager.getSelection()).toBe("https://example.com/abc/def?x=1\nsecond");
  });

  // Final review: the override binds to ghostty-web's private selection fields; when a later
  // ghostty-web reshapes them, copy must fall back to ghostty's own text, not silently copy "".
  it("falls back to ghostty's own selection text when its selection fields are unknown", async () => {
    const { controller } = await createWithBuffer(["one", "two"], [false, false], 20, (c) => {
      Object.assign(c.terminal.selectionManager, { getSelection: () => "ghostty's own text" });
    });
    const selectionManager = controller.terminal.selectionManager as unknown as {
      selectionStart?: unknown;
      selectionEnd?: unknown;
      getSelection: () => string;
    };
    selectionManager.selectionStart = { x: 0, y: 0 };
    selectionManager.selectionEnd = { x: 3, y: 0 };
    expect(selectionManager.getSelection()).toBe("ghostty's own text");
  });
});
