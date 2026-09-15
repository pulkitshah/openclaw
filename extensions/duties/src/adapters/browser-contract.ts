// Leaf contract for the browser surface the runner drives. It lives outside
// `runner.ts` because `adapters/render.ts` drives the same browser to print a
// PDF, and `runner.ts` already depends on that render adapter: importing the
// type back out of the runner made the two modules cycle.
import type { Target } from "../duty.js";

/** Every acting verb takes the authored step budget so a `timeoutMs: 60000` step is not silently
 *  capped at the adapter's blanket default. */
export type BrowserAdapter = {
  open(url: string, timeoutMs?: number): Promise<{ targetId: string }>;
  navigate(targetId: string, url: string, timeoutMs?: number): Promise<void>;
  isVisible(targetId: string, target: Target): Promise<boolean>;
  click(targetId: string, target: Target, timeoutMs?: number): Promise<void>;
  fill(targetId: string, target: Target, value: string, timeoutMs?: number): Promise<void>;
  select(targetId: string, target: Target, value: string, timeoutMs?: number): Promise<void>;
  press(targetId: string, key: string, timeoutMs?: number): Promise<void>;
  waitFor(
    targetId: string,
    opts: { target?: Target; text?: string; url?: string; timeoutMs?: number },
  ): Promise<void>;
  text(targetId: string, target?: Target, timeoutMs?: number): Promise<string>;
  url(targetId: string): Promise<string>;
  evaluate(targetId: string, fn: string, timeoutMs?: number): Promise<unknown>;
  /** Captures the tab and registers the image in the evidence blob store, returning its blob key.
   *  `undefined` when this adapter has no blob store (a render tab, which keeps its image as a
   *  file instead — see `screenshotPath`). */
  screenshot(targetId: string): Promise<string | undefined>;
  /** Captures the tab and returns the path the browser plugin wrote the image to, with no blob
   *  store involved. The render adapter copies that file next to the PDF it just printed, so a
   *  rendered document has a picture of itself that needs no PDF viewer to look at. */
  screenshotPath(targetId: string): Promise<string | undefined>;
  close(targetId: string): Promise<void>;
  /** Prints the tab to PDF via the browser plugin's `/pdf` route; returns the absolute path the
   *  browser plugin wrote it to (not the caller's destination — the render adapter copies it). */
  pdf(targetId: string): Promise<string>;
  /** Drains the transport-retry notes recorded since the last drain, so a retried read is
   *  reported in the step's evidence summary instead of passing silently. */
  drainRetryNotes?: () => string[];
};
