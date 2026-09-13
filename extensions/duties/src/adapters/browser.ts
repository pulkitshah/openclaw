/**
 * Browser adapter over the Gateway's `browser.request` method.
 *
 * Confirmed response/body shapes (see extensions/browser/src/browser/client.ts,
 * client-actions.ts, client-actions.types.ts, form-fields.ts):
 * - POST /tabs/open -> BrowserOpenResult (a BrowserTab) with a required `targetId`.
 * - GET /snapshot -> for format="ai" (forced explicitly; a profile's default format can
 *   otherwise resolve to "aria", which has no `snapshot`/`refs` fields at all) the body is
 *   `{ ok, format: "ai", targetId, url, snapshot: string, refs?: Record<string, { role, name?,
 *   nth? }>, ... }` (client.ts:152). Targets are resolved from the structured `refs` map, never
 *   by regex-parsing the `snapshot` text: the map's keys are opaque ref strings (role-snapshot
 *   refs look like "e37", Chrome MCP refs look like "mcp-ref:<12hex>:<n>" — chrome-mcp-routing.ts)
 *   and its values carry already-decoded names, so quoting/escaping in the rendered snapshot text
 *   never needs to be re-parsed. `interactive=true` filters the map down to interactive roles
 *   only (pw-role-snapshot.ts / chrome-mcp.snapshot.ts), so a content-only target (e.g. a
 *   heading, or a text-only target with no role) may need a second, unfiltered snapshot.
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
 *   action — it is polled locally via snapshot + resolveRef instead. A waitFor with no
 *   target/text/url is mapped to a plain timed wait (`{ kind: "wait", timeMs }`).
 * - POST /act "evaluate" -> the route always answers `{ ok, targetId, url, result }`
 *   (agent.act.ts); `result` itself may legitimately be `null`/`undefined`, so presence of the
 *   `result` key (not its truthiness) decides whether to return it.
 * - POST /screenshot -> BrowserActionPathResult = `{ ok, path: string, targetId, url?, ... }`.
 *   There is no base64/data field: the server writes the image to a filesystem path — including
 *   when browser.request is proxied to a remote node, whose result files are rewritten to a
 *   Gateway-local path before this method ever sees them (gateway/browser-request.ts:264,
 *   browser/proxy-files.ts:92-104) — so `path` is always readable locally.
 *
 * Snapshot text/refs are never logged, stored, or included in error messages: only match counts
 * and `describeTarget(target)` (the owner-authored target description) appear in thrown errors.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Target } from "../duty.js";
import { describeTarget, type BrowserAdapter } from "../runner.js";

type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
type RefInfo = { role: string; name?: string; nth?: number };
type RefsMap = Record<string, RefInfo>;

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const UNCONDITIONAL_WAIT_DEFAULT_MS = 1_000;
const CSS_VISIBILITY_PROBE_TIMEOUT_MS = 1_500;
const POLL_INTERVAL_MS = 250;

/**
 * Mirrors extensions/browser/src/browser/snapshot-roles.ts INTERACTIVE_ROLES. Extension code
 * cannot import across the extensions boundary (see extensions/CLAUDE.md), so this list is kept
 * as a local copy — used only to decide whether a target's role could plausibly appear in an
 * `interactive=true` snapshot, never to reproduce the server's own filtering.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/** Resolve a target against a snapshot's structured refs map. Never touches snapshot text. */
export function resolveRef(refs: RefsMap, target: Target): { ref?: string; matches: string[] } {
  const matches: string[] = [];
  if (target.role || target.name || target.text) {
    for (const [ref, info] of Object.entries(refs)) {
      const name = info.name ?? "";
      if (target.role && info.role.toLowerCase() !== target.role.toLowerCase()) continue;
      if (target.name && name.toLowerCase() !== target.name.toLowerCase()) continue;
      if (target.text && !name.toLowerCase().includes(target.text.toLowerCase())) continue;
      matches.push(ref);
    }
  }
  return { ref: matches.length === 1 ? matches[0] : undefined, matches };
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

  const act = <T = unknown>(targetId: string, body: Record<string, unknown>, timeoutMs?: number) =>
    call<T>("POST", "/act", { body: { ...body, targetId }, timeoutMs });

  /** `interactive: true` asks the server to filter to interactive roles only; omitted asks for
   * everything (content and structural roles included). */
  const snapshotRefs = async (targetId: string, interactive: boolean): Promise<RefsMap> => {
    const result = await call<{ refs?: RefsMap }>("GET", "/snapshot", {
      query: {
        targetId,
        format: "ai",
        refs: "role",
        ...(interactive ? { interactive: "true" } : {}),
      },
    });
    return result.refs ?? {};
  };

  /**
   * Resolves a target from the interactive-only snapshot first; if that has zero matches and the
   * target's role isn't necessarily interactive (no role at all, a non-interactive role, or a
   * text-only target), retries against an unfiltered snapshot. Ambiguous (>1) results are
   * returned as-is — a second, unfiltered snapshot cannot make an ambiguous match unambiguous.
   */
  const resolveTarget = async (
    targetId: string,
    target: Target,
  ): Promise<{ ref?: string; matches: string[] }> => {
    const first = resolveRef(await snapshotRefs(targetId, true), target);
    if (first.ref || first.matches.length > 1) return first;
    const isInteractiveRole = target.role
      ? INTERACTIVE_ROLES.has(target.role.toLowerCase())
      : false;
    const targetHasOnlyText = Boolean(target.text) && !target.role && !target.name;
    if (first.matches.length === 0 && (!isInteractiveRole || targetHasOnlyText)) {
      const second = resolveRef(await snapshotRefs(targetId, false), target);
      if (second.matches.length > 0) return second;
    }
    return first;
  };

  const locate = async (
    targetId: string,
    target: Target,
  ): Promise<{ ref?: string; selector?: string }> => {
    if (!target.role && !target.name && !target.text) {
      if (target.css) return { selector: target.css };
      throw new Error(`${describeTarget(target)}: target needs a role, name, text, or css`);
    }
    const { ref, matches } = await resolveTarget(targetId, target);
    if (ref) return { ref };
    if (target.css) return { selector: target.css };
    throw new Error(
      matches.length > 1
        ? `${describeTarget(target)}: ${matches.length} matches (ambiguous)`
        : `${describeTarget(target)}: not found on the page`,
    );
  };

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
      if (target.role || target.name || target.text) {
        const { ref } = await resolveTarget(targetId, target);
        return Boolean(ref);
      }
      if (!target.css) return false;
      try {
        await act(
          targetId,
          { kind: "wait", selector: target.css, timeoutMs: CSS_VISIBILITY_PROBE_TIMEOUT_MS },
          CSS_VISIBILITY_PROBE_TIMEOUT_MS + 500,
        );
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
      const deadline = Date.now() + timeoutMs;
      const body: Record<string, unknown> = { kind: "wait" };
      let hasCondition = false;
      if (opts.text) {
        body.text = opts.text;
        hasCondition = true;
      }
      if (opts.url) {
        body.url = opts.url;
        hasCondition = true;
      }
      if (opts.target?.css) {
        body.selector = opts.target.css;
        hasCondition = true;
      }
      if (hasCondition) {
        await act(targetId, body, timeoutMs + 5_000);
      } else if (!opts.target) {
        const timeMs = opts.timeoutMs ?? UNCONDITIONAL_WAIT_DEFAULT_MS;
        await act(targetId, { kind: "wait", timeMs }, timeMs + 5_000);
      }
      if (opts.target && !opts.target.css) {
        await waitForTarget(targetId, opts.target, Math.max(0, deadline - Date.now()));
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
      return "result" in r ? r.result : undefined;
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
