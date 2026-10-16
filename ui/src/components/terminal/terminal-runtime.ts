import type { CreateGhosttyTerminalOptions } from "@openclaw/libterminal/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { UrlRegexProvider } from "ghostty-web";

function isEventListener(value: unknown): value is EventListener {
  return typeof value === "function";
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
  // link, a doc reference — was never clickable. Only single-line URLs (`UrlRegexProvider`'s own
  // documented limit); a long URL that wraps across rows still needs manual selection.
  const linkProvider = new UrlRegexProvider(terminal);
  terminal.registerLinkProvider(linkProvider);
  const mouseUpCandidate = asOptionalRecord(terminal)?.handleMouseUp;
  let handleMouseUp = isEventListener(mouseUpCandidate) ? mouseUpCandidate : undefined;
  // ghostty-web 0.4.0 records the document-level mousedown target and clears the selection on
  // any click whose document-level target lies outside its canvas. The panel renders the
  // terminal inside a shadow root, which retargets both to the host, so every drag-selection
  // was wiped by its own click: the text still reached the clipboard (copy-on-select) but the
  // highlight vanished. Re-record the composed target after ghostty's listener (registered at
  // open, so it runs first) so an in-canvas click keeps the selection; clicks elsewhere still
  // clear it.
  const selectionManager = asOptionalRecord(terminal)?.selectionManager;
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
    linkProvider.dispose();
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
