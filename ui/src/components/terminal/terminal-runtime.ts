import type { CreateGhosttyTerminalOptions } from "@openclaw/libterminal/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ILink, ILinkProvider } from "ghostty-web";

function isEventListener(value: unknown): value is EventListener {
  return typeof value === "function";
}

type BufferLine = {
  length: number;
  /** ghostty's row flag: this row soft-wraps, the next row continues it. */
  isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
};
type LineBuffer = { active: { getLine(y: number): BufferLine | undefined } };
type SelectionPoint = { col: number; absoluteRow: number };

function isLineBuffer(value: unknown): value is LineBuffer {
  const active = asOptionalRecord(asOptionalRecord(value)?.active);
  return typeof active?.getLine === "function";
}

function isSelectionPoint(value: unknown): value is SelectionPoint {
  const point = asOptionalRecord(value);
  return typeof point?.col === "number" && typeof point.absoluteRow === "number";
}

const URL_PATTERN = /(?:https?|ftp):\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** The rows of the logical line that row `y` belongs to, joined across soft wraps. */
function logicalLineRows(buffer: LineBuffer, y: number): Array<{ y: number; text: string }> {
  let start = y;
  while (start > 0 && buffer.active.getLine(start - 1)?.isWrapped) {
    start -= 1;
  }
  const rows: Array<{ y: number; text: string }> = [];
  for (let row = start; ; row += 1) {
    const line = buffer.active.getLine(row);
    if (!line) {
      break;
    }
    rows.push({ y: row, text: line.translateToString(!line.isWrapped) });
    if (!line.isWrapped) {
      break;
    }
  }
  return rows;
}

// ghostty-web's UrlRegexProvider reads one row at a time, so a URL that soft-wraps (every OAuth
// sign-in link a CLI prints at 100+ columns) was never a link. This one joins the wrapped rows
// first and reports the link's full range; activation keeps ghostty's modifier-click rule.
function createWrappedUrlLinkProvider(buffer: LineBuffer): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const rows = logicalLineRows(buffer, y);
      const text = rows.map((row) => row.text).join("");
      const positionOf = (offset: number) => {
        let consumed = 0;
        for (const row of rows) {
          if (offset < consumed + row.text.length) {
            return { x: offset - consumed, y: row.y };
          }
          consumed += row.text.length;
        }
        const last = rows[rows.length - 1];
        return { x: Math.max(0, last.text.length - 1), y: last.y };
      };
      const links: ILink[] = [];
      for (const match of text.matchAll(URL_PATTERN)) {
        const url = match[0].replace(TRAILING_PUNCTUATION, "");
        if (url.length <= 8) {
          continue;
        }
        links.push({
          text: url,
          range: { start: positionOf(match.index), end: positionOf(match.index + url.length - 1) },
          activate: (event) => {
            if (event.ctrlKey || event.metaKey) {
              window.open(url, "_blank", "noopener,noreferrer");
            }
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
    dispose() {},
  };
}

// ghostty-web 0.4.0 joins the rows of a selection with newlines whether or not they soft-wrap,
// so the same wrapped URL pasted as several lines. Same shape as its getSelection, minus the
// newline (and the trailing-space trim) on rows that continue.
function selectionTextAcrossWraps(buffer: LineBuffer, from: SelectionPoint, to: SelectionPoint) {
  let [start, end] = [from, to];
  if (
    start.absoluteRow > end.absoluteRow ||
    (start.absoluteRow === end.absoluteRow && start.col > end.col)
  ) {
    [start, end] = [end, start];
  }
  let text = "";
  for (let row = start.absoluteRow; row <= end.absoluteRow; row += 1) {
    const line = buffer.active.getLine(row);
    if (!line) {
      continue;
    }
    const continues = row < end.absoluteRow && line.isWrapped;
    text += line.translateToString(
      !continues,
      row === start.absoluteRow ? start.col : 0,
      row === end.absoluteRow ? end.col + 1 : line.length,
    );
    if (row < end.absoluteRow && !continues) {
      text += "\n";
    }
  }
  return text;
}

/** Creates a terminal whose WASM memory is never reused by another tab. */
export async function createIsolatedGhosttyTerminal(options: CreateGhosttyTerminalOptions) {
  const [{ createGhosttyTerminal, loadGhosttyRuntime }, ghosttyModule] = await Promise.all([
    import("@openclaw/libterminal/browser"),
    import("ghostty-web"),
  ]);
  // ghostty-web 0.4.0 reuses freed WASM pages, exposing stale cells and corrupting
  // later terminals (coder/ghostty-web#142). Per-tab runtimes confine disposal.
  const runtime = await loadGhosttyRuntime({ module: ghosttyModule });
  const controller = await createGhosttyTerminal({ ...options, runtime, autoFit: false });
  const dispose = controller.dispose.bind(controller);
  const terminal = controller.terminal;
  const measurement = new runtime.FitAddon();
  measurement.activate(terminal);
  let observer: ResizeObserver | undefined;
  // Ghostty ignores defaultPrevented; its custom handler returns true to consume.
  // App capture listeners own dock shortcuts before they can become PTY input.
  terminal.attachCustomKeyEventHandler((event) => event.defaultPrevented);
  // No link provider is registered by default, so a URL a session prints — an OAuth sign-in
  // link, a doc reference — was never clickable. Wrap state is exposed for the active screen
  // only; a URL that has scrolled into scrollback is reported row by row.
  const bufferCandidate = asOptionalRecord(terminal)?.buffer;
  const buffer = isLineBuffer(bufferCandidate) ? bufferCandidate : undefined;
  const linkProvider: ILinkProvider = buffer
    ? createWrappedUrlLinkProvider(buffer)
    : { provideLinks: (_y, callback) => callback(undefined) };
  terminal.registerLinkProvider(linkProvider);
  const selectionManager = asOptionalRecord(terminal)?.selectionManager;
  if (selectionManager && buffer) {
    selectionManager.getSelection = () => {
      const { selectionStart, selectionEnd } = selectionManager;
      return isSelectionPoint(selectionStart) && isSelectionPoint(selectionEnd)
        ? selectionTextAcrossWraps(buffer, selectionStart, selectionEnd)
        : "";
    };
  }
  const mouseUpCandidate = asOptionalRecord(terminal)?.handleMouseUp;
  let handleMouseUp = isEventListener(mouseUpCandidate) ? mouseUpCandidate : undefined;
  // ghostty-web 0.4.0 records the document-level mousedown target and clears the selection on
  // any click whose document-level target lies outside its canvas. The panel renders the
  // terminal inside a shadow root, which retargets both to the host, so every drag-selection
  // was wiped by its own click: the text still reached the clipboard (copy-on-select) but the
  // highlight vanished. Re-record the composed target after ghostty's listener (registered at
  // open, so it runs first) so an in-canvas click keeps the selection; clicks elsewhere still
  // clear it.
  const recordComposedMouseDownTarget = (event: MouseEvent) => {
    const canvas = options.parent.querySelector("canvas");
    if (selectionManager && canvas && event.composedPath().includes(canvas)) {
      selectionManager.mouseDownTarget = canvas;
    }
  };
  document.addEventListener("mousedown", recordComposedMouseDownTarget);
  let disposed = false;
  // Ghostty 0.4.0 drops resize notifications during its 50ms fit lock. Measure
  // through its public addon, but let one owner apply every final layout size.
  controller.fit = () => {
    if (disposed) {
      return;
    }
    const size = measurement.proposeDimensions();
    if (size && (size.cols !== terminal.cols || size.rows !== terminal.rows)) {
      controller.resize({ columns: size.cols, rows: size.rows });
    }
  };
  controller.dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    observer?.disconnect();
    measurement.dispose();
    linkProvider.dispose?.();
    document.removeEventListener("mousedown", recordComposedMouseDownTarget);
    // ghostty-web 0.4.0 clears isOpen before cleanup, skipping this listener removal.
    if (handleMouseUp) {
      document.removeEventListener("mouseup", handleMouseUp);
      handleMouseUp = undefined;
    }
    dispose();
  };
  if (options.signal?.aborted) {
    controller.dispose();
  } else if (options.autoFit !== false) {
    observer = new ResizeObserver(() => controller.fit());
    observer.observe(options.parent);
    if (!options.size) {
      controller.fit();
    }
  }
  return controller;
}
