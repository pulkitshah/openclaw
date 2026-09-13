import { randomUUID } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { BrowserAdapter } from "../runner.js";

export const RENDER_ROUTE_PATH = "/plugins/duties/render/";
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
  baseUrl: string;
  ttlMs?: number;
  now?: () => number;
}): RenderServer {
  const ttl = params.ttlMs ?? DEFAULT_TTL_MS;
  const now = params.now ?? Date.now;
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
      return { token, url: `${params.baseUrl}${RENDER_ROUTE_PATH}${token}` };
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
      res.end(entry.html);
      return true;
    },
  };
}

export type RenderAdapter = { toPdf(html: string, destPath: string): Promise<{ bytes: number }> };

export function createRenderAdapter(params: {
  server: RenderServer;
  browser: Pick<BrowserAdapter, "open" | "pdf" | "close">;
  timeoutMs?: number;
}): RenderAdapter {
  return {
    async toPdf(html, destPath) {
      const { url } = params.server.publish(html);
      const { targetId } = await params.browser.open(url, params.timeoutMs ?? 30_000);
      try {
        const produced = await params.browser.pdf(targetId);
        await mkdir(path.dirname(destPath), { recursive: true });
        await copyFile(produced, destPath);
        return { bytes: (await stat(destPath)).size };
      } finally {
        await params.browser.close(targetId).catch(() => {});
      }
    },
  };
}
