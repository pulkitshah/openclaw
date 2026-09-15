import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { RENDER_ALLOWLIST_REMEDY } from "../setup.js";
import type { BrowserAdapter } from "./browser-contract.js";

export const RENDER_ROUTE_PATH = "/plugins/duties/render/";
/** The `<meta name>` the served document carries, holding that document's own single-use token.
 *  It is what proves the tab the adapter is about to print is the document it just published. */
export const RENDER_MARKER_NAME = "duties-render";
const DEFAULT_TTL_MS = 60_000;

export type RenderServer = {
  path: string;
  /** Serves a published document once (single-use token), 404 otherwise. Returns true when handled. */
  handler: (req: IncomingMessage, res: ServerResponse) => boolean;
  publish(html: string): { url: string; token: string };
};

/** The browser plugin only navigates to http(s), so rendered HTML is handed to the managed browser
 *  through this route: a random single-use token, served once, expiring after `ttlMs`. The route is
 *  registered with `auth: "plugin"` — the token is the whole authorization, and the HTML never
 *  contains a credential (validateDuty confines those to fill/select values). */
export function createRenderServer(params: {
  /** A getter is what the plugin passes: the Gateway's port and TLS scheme come from config,
   *  which is reloaded in place, so a base url captured at registration goes stale. */
  baseUrl: string | (() => string);
  ttlMs?: number;
  now?: () => number;
}): RenderServer {
  const ttl = params.ttlMs ?? DEFAULT_TTL_MS;
  const now = params.now ?? Date.now;
  const baseUrl = () => (typeof params.baseUrl === "function" ? params.baseUrl() : params.baseUrl);
  const pending = new Map<string, { html: string; expiresAt: number }>();
  const sweep = () => {
    const t = now();
    for (const [token, entry] of pending) if (entry.expiresAt <= t) pending.delete(token);
  };
  return {
    path: RENDER_ROUTE_PATH,
    publish(html) {
      sweep();
      const token = randomUUID();
      pending.set(token, { html, expiresAt: now() + ttl });
      return { token, url: `${baseUrl()}${RENDER_ROUTE_PATH}${token}` };
    },
    handler(req, res) {
      const url = req.url ?? "";
      if (!url.startsWith(RENDER_ROUTE_PATH)) return false;
      sweep();
      const token = url.slice(RENDER_ROUTE_PATH.length).split("?")[0] ?? "";
      const entry = pending.get(token);
      if (!entry) {
        res.statusCode = 404;
        res.end();
        return true;
      }
      pending.delete(token);
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      // Prepended rather than spliced into a `<head>`: a template's html is an authored fragment
      // with no guaranteed head, and a leading `<meta>` is parsed into the implied head anyway
      // (HTML "before head" insertion mode), so `document.querySelector` finds it either way. The
      // token is a uuid, so it needs no escaping to sit inside the attribute.
      res.end(`<meta name="${RENDER_MARKER_NAME}" content="${token}">\n${entry.html}`);
      return true;
    },
  };
}

export type RenderResult = {
  bytes: number;
  /** Where the captured preview image of the printed page landed, when one could be taken.
   *  Absent is normal (a profile with no screenshot route); it never fails the render. Its
   *  extension names the real format (see `previewContentType`) — the browser adapter's own
   *  `screenshotPath` can hand back a JPEG-normalised capture instead of a PNG. */
  previewPath?: string;
};

/** The content type a `previewPath` (or any `screenshotPath` capture) actually holds, from its
 *  extension. Mirrors `screenshot()`'s own detection in `adapters/browser.ts` so every consumer of
 *  a captured preview — `copyPreview` below, `duties.run.file {kind:"preview"}`, and
 *  `duties.template.preview` in `gateway-methods.ts` — labels the same bytes the same way instead
 *  of assuming PNG. */
export function previewContentType(filePath: string): "image/jpeg" | "image/png" {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
}
export type RenderAdapter = { toPdf(html: string, destPath: string): Promise<RenderResult> };

/** One evaluate for the whole verification: the marker that proves identity plus the two strings
 *  used to describe whatever loaded instead. Function SOURCE, not a body — the act route evals
 *  `"(" + fnSource + ")"` and requires the result to be a function
 *  (extensions/browser/src/browser/pw-tools-core.interactions.actions.ts:389-400). */
const MARKER_PROBE_FN = `() => ({
  marker: document.querySelector('meta[name="${RENDER_MARKER_NAME}"]')?.content ?? "",
  title: document.title ?? "",
  text: (document.body?.innerText ?? "").trim()
})`;

/** The shapes the navigation guard and the SSRF policy under it report a blocked loopback
 *  navigation as (`Blocked hostname or private/internal/special-use IP address`,
 *  src/infra/net/ssrf.ts:360; `Navigation blocked: …`,
 *  extensions/browser/src/browser/navigation-guard.ts:133-163). Matching them is what lets the one
 *  error an owner sees carry its own remedy. */
const NAVIGATION_BLOCKED_RE = /navigation blocked|blocked hostname|private\/internal|special-use/iu;

/** What the tab is showing, in the fewest words that identify it: the title, else the first 80
 *  characters of its text. Never the page's full text — a render page can hold customer data. */
function describePage(title: string, text: string): string {
  const label = title.trim() || text.trim();
  return label.slice(0, 80);
}

export function createRenderAdapter(params: {
  server: RenderServer;
  browser: Pick<BrowserAdapter, "open" | "pdf" | "close" | "evaluate" | "text" | "screenshotPath">;
  timeoutMs?: number;
}): RenderAdapter {
  const { browser } = params;
  /** Reads the marker the served document carries. Falls back to `/text` for the description
   *  only: the marker lives in a `<meta>`, which page text never contains, so a probe that could
   *  not run is a failure to verify, not a pass. */
  const readPage = async (targetId: string): Promise<{ marker: string; description: string }> => {
    try {
      const probed = await browser.evaluate(targetId, MARKER_PROBE_FN, params.timeoutMs);
      if (isRecord(probed)) {
        return {
          marker: typeof probed.marker === "string" ? probed.marker : "",
          description: describePage(
            typeof probed.title === "string" ? probed.title : "",
            typeof probed.text === "string" ? probed.text : "",
          ),
        };
      }
    } catch {
      // A profile that cannot evaluate still has to say what it is showing.
    }
    const text = await browser.text(targetId).catch(() => "");
    return { marker: "", description: describePage("", text) };
  };

  return {
    async toPdf(html, destPath) {
      const { url, token } = params.server.publish(html);
      let targetId: string;
      try {
        ({ targetId } = await browser.open(url, params.timeoutMs ?? 30_000));
      } catch (error) {
        // Naming the URL is the whole point: the ways this fails in practice are a wrong scheme
        // (a TLS-enabled Gateway), a wrong port, and the browser's own SSRF policy refusing
        // loopback — and a bare browser navigation error says none of them. The URL carries a
        // single-use token, never a credential.
        const message = coerceErrorMessage(error);
        const remedy = NAVIGATION_BLOCKED_RE.test(message) ? ` — ${RENDER_ALLOWLIST_REMEDY}` : "";
        throw new Error(`could not open the render page at ${url}: ${message}${remedy}`, {
          cause: error,
        });
      }
      try {
        // Printing whatever the tab happens to show is how a 404 page, an interstitial, or a
        // second Gateway's answer became a plausible `<name>.pdf` that a `deliver` step then sent
        // to a customer. The marker is this document's own single-use token, so only the page
        // just published can carry it.
        const page = await readPage(targetId);
        if (page.marker !== token) {
          throw new Error(
            `render page not served at ${url} (got ${page.description || "an empty page"})`,
          );
        }
        const produced = await browser.pdf(targetId);
        await mkdir(path.dirname(destPath), { recursive: true });
        await copyFile(produced, destPath);
        const bytes = (await stat(destPath)).size;
        // Best-effort: a PNG of the same tab, next to the PDF, so the owner can see the document
        // in the Control UI without a PDF viewer. A profile that cannot screenshot still renders.
        const previewPath = await copyPreview(targetId).catch(() => undefined);
        return { bytes, ...(previewPath ? { previewPath } : {}) };
      } finally {
        await browser.close(targetId).catch(() => {});
      }

      async function copyPreview(tab: string): Promise<string | undefined> {
        const shot = await browser.screenshotPath(tab);
        if (!shot) return undefined;
        // Named after what the capture actually is (`previewContentType`), not assumed PNG: the
        // browser adapter's screenshot route can hand back a JPEG-normalised capture.
        const shotExt = previewContentType(shot) === "image/jpeg" ? ".jpg" : ".png";
        const destExt = path.extname(destPath);
        const destBase = destExt ? path.basename(destPath, destExt) : path.basename(destPath);
        const dest = path.join(path.dirname(destPath), `${destBase}${shotExt}`);
        await copyFile(shot, dest);
        return dest;
      }
    },
  };
}
