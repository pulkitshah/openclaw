/**
 * Browser adapter over the Gateway's `browser.request` method.
 *
 * Confirmed response/body shapes (see extensions/browser/src/browser/client.ts,
 * client-actions.ts, client-actions.types.ts, form-fields.ts):
 * - POST /tabs/open -> BrowserOpenResult (a BrowserTab) with a required `targetId`.
 * - GET /snapshot -> for format="ai" (forced explicitly; a profile's default format can
 *   otherwise resolve to "aria", which has no `snapshot` string field at all) the body is
 *   `{ ok, format: "ai", targetId, url, snapshot: string, ... }` — the field is always
 *   `snapshot`, never `text`.
 * - GET /tabs -> BrowserTabsResult = `{ running: true, tabs: BrowserTab[] } | { running: false, tabs: [] }`.
 *   Always the wrapped object, never a bare array.
 * - GET /text -> `{ ok, targetId, url?, text: string, truncated }`.
 * - POST /act "fill" -> fields are `{ ref, type?, value? }` (BrowserFormField / form-fields.ts
 *   normalizeBrowserFormField): `ref` is REQUIRED and `selector` is a rejected/unsupported key
 *   inside a fill field. A css-only target therefore cannot use kind:"fill"; it is filled via
 *   kind:"type", whose selector is a top-level field.
 * - POST /act "wait" requires at least one of timeMs/text/textGone/selector/url/loadState/fn
 *   (agent.act.normalize.ts); `timeoutMs` alone does not satisfy it, and "wait" has no `ref`
 *   field at all, so a role/name/text target (no css) cannot be waited for through the wait
 *   action — it is polled locally via snapshot + resolveRef instead.
 * - POST /screenshot -> BrowserActionPathResult = `{ ok, path: string, targetId, url?, ... }`.
 *   There is no base64/data field: the server writes the image to a filesystem path that this
 *   adapter reads and hands to `blobs.put`.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Target } from "../duty.js";
import { describeTarget, type BrowserAdapter } from "../runner.js";

type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
const LINE_RE = /^\s*-\s*([a-z]+)\s*(?:"((?:[^"\\]|\\.)*)")?.*?\[ref=([a-z0-9]+)\]/iu;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 250;

export function resolveRef(snapshot: string, target: Target): string | undefined {
  const matches: string[] = [];
  for (const line of snapshot.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const role = m[1];
    const name = m[2] ?? "";
    const ref = m[3];
    if (!role || !ref) continue;
    if (target.role && role.toLowerCase() !== target.role.toLowerCase()) continue;
    if (target.name && name.toLowerCase() !== target.name.toLowerCase()) continue;
    if (target.text && !name.toLowerCase().includes(target.text.toLowerCase())) continue;
    if (!target.role && !target.name && !target.text) continue;
    matches.push(ref);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function countLooseMatches(snapshot: string, target: Target): number {
  return snapshot.split("\n").filter((line) => {
    if (!LINE_RE.test(line)) return false;
    const lower = line.toLowerCase();
    if (target.role && !lower.includes(`- ${target.role.toLowerCase()}`)) return false;
    if (target.name && !lower.includes(`"${target.name.toLowerCase()}"`)) return false;
    return true;
  }).length;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createBrowserAdapter(params: {
  request: Request;
  profile: string;
  blobs?: { put(bytes: Uint8Array, contentType: string): Promise<string> };
}): BrowserAdapter {
  const { request, profile } = params;

  const call = <T = unknown>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, unknown>; body?: unknown; timeoutMs?: number } = {},
  ) =>
    request<T>("browser.request", {
      method,
      path,
      query: { profile, ...opts.query },
      body: opts.body,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });

  const snapshot = async (targetId: string): Promise<string> => {
    const result = await call<{ snapshot?: string }>("GET", "/snapshot", {
      query: { targetId, format: "ai", interactive: "true", refs: "role" },
    });
    return result.snapshot ?? "";
  };

  const locate = async (
    targetId: string,
    target: Target,
  ): Promise<{ ref?: string; selector?: string }> => {
    if (!target.role && !target.name && !target.text) {
      if (target.css) return { selector: target.css };
      throw new Error(`${describeTarget(target)}: target needs a role, name, text, or css`);
    }
    const snap = await snapshot(targetId);
    const ref = resolveRef(snap, target);
    if (ref) return { ref };
    if (target.css) return { selector: target.css };
    const count = countLooseMatches(snap, target);
    throw new Error(
      count > 1
        ? `${describeTarget(target)}: ${count} matches (ambiguous)`
        : `${describeTarget(target)}: not found on the page`,
    );
  };

  const act = <T = unknown>(targetId: string, body: Record<string, unknown>, timeoutMs?: number) =>
    call<T>("POST", "/act", { body: { ...body, targetId }, timeoutMs });

  const waitForTarget = async (
    targetId: string,
    target: Target,
    timeoutMs: number,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (;;) {
      try {
        await locate(targetId, target);
        return;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        throw lastError instanceof Error
          ? lastError
          : new Error(`${describeTarget(target)}: not found on the page`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  };

  return {
    async open(url) {
      const r = await call<{ targetId: string }>("POST", "/tabs/open", {
        body: { url, label: "duty" },
      });
      return { targetId: r.targetId };
    },
    async navigate(targetId, url) {
      await call("POST", "/navigate", { body: { url, targetId } });
    },
    async isVisible(targetId, target) {
      try {
        await locate(targetId, target);
        return true;
      } catch {
        return false;
      }
    },
    async click(targetId, target) {
      await act(targetId, { kind: "click", ...(await locate(targetId, target)) });
    },
    async fill(targetId, target, value) {
      const loc = await locate(targetId, target);
      if (loc.ref) {
        await act(targetId, { kind: "fill", fields: [{ ref: loc.ref, value }] });
      } else if (loc.selector) {
        await act(targetId, { kind: "type", selector: loc.selector, text: value });
      } else {
        throw new Error(`${describeTarget(target)}: not found on the page`);
      }
    },
    async select(targetId, target, value) {
      await act(targetId, { kind: "select", ...(await locate(targetId, target)), values: [value] });
    },
    async press(targetId, key) {
      await act(targetId, { kind: "press", key });
    },
    async waitFor(targetId, opts) {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const body: Record<string, unknown> = { kind: "wait", timeoutMs };
      let hasServerCondition = false;
      if (opts.text) {
        body.text = opts.text;
        hasServerCondition = true;
      }
      if (opts.url) {
        body.url = opts.url;
        hasServerCondition = true;
      }
      if (opts.target?.css) {
        body.selector = opts.target.css;
        hasServerCondition = true;
      }
      if (hasServerCondition) {
        await act(targetId, body, timeoutMs + 5_000);
      }
      if (opts.target && !opts.target.css) {
        await waitForTarget(targetId, opts.target, timeoutMs);
      }
    },
    async text(targetId, target) {
      const r = await call<{ text?: string }>("GET", "/text", {
        query: { targetId, ...(target?.css ? { selector: target.css } : {}) },
      });
      return r.text ?? "";
    },
    async url(targetId) {
      const res = await call<{ running: boolean; tabs: Array<{ targetId: string; url: string }> }>(
        "GET",
        "/tabs",
      );
      return res.tabs.find((t) => t.targetId === targetId)?.url ?? "";
    },
    async evaluate(targetId, fn) {
      const r = await act<{ result?: unknown }>(targetId, { kind: "evaluate", fn });
      return r?.result ?? r;
    },
    async screenshot(targetId) {
      if (!params.blobs) return undefined;
      const r = await call<{ path?: string }>("POST", "/screenshot", {
        body: { targetId, fullPage: false },
      });
      if (!r.path) return undefined;
      const bytes = await readFile(r.path);
      const ext = extname(r.path).toLowerCase();
      const contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
      return params.blobs.put(bytes, contentType);
    },
    async close(targetId) {
      await call("DELETE", `/tabs/${encodeURIComponent(targetId)}`);
    },
  };
}
