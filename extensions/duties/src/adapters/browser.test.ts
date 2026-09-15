import { describe, expect, it, vi } from "vitest";
import { createBrowserAdapter, resolveRef } from "./browser.js";
import { asRequest } from "./test-helpers.js";

const REFS = {
  e33: { role: "textbox", name: "User Name" },
  e35: { role: "textbox", name: "Password" },
  e37: { role: "button", name: "Sign-in" },
  e40: { role: "button", name: "Sign-in" },
  e38: { role: "link", name: "Forgot your password?" },
};

describe("resolveRef", () => {
  it("matches role + name exactly and refuses ambiguous matches", () => {
    expect(resolveRef(REFS, { role: "textbox", name: "User Name" })).toEqual({
      ref: "e33",
      matches: ["e33"],
    });
    expect(resolveRef(REFS, { role: "button", name: "Sign-in" })).toEqual({
      ref: undefined,
      matches: ["e37", "e40"],
    });
    expect(resolveRef(REFS, { text: "forgot" })).toEqual({ ref: "e38", matches: ["e38"] });
  });

  it("resolves opaque Chrome MCP ref keys (mcp-ref:<12hex>:<n>)", () => {
    const refs = { "mcp-ref:ab12cd34ef56:7": { role: "button", name: "Submit" } };
    expect(resolveRef(refs, { role: "button", name: "Submit" })).toEqual({
      ref: "mcp-ref:ab12cd34ef56:7",
      matches: ["mcp-ref:ab12cd34ef56:7"],
    });
  });

  it("matches decoded names containing quotes", () => {
    const refs = { e1: { role: "button", name: 'Say "hi"' } };
    expect(resolveRef(refs, { name: 'Say "hi"' })).toEqual({ ref: "e1", matches: ["e1"] });
  });

  it("counts only real name matches for a text-only target", () => {
    const refs = {
      e1: { role: "link", name: "abc" },
      e2: { role: "button" },
      e3: { role: "link", name: "abcdef" },
    };
    expect(resolveRef(refs, { text: "abc" }).matches).toEqual(["e1", "e3"]);
  });

  it("returns no matches when the target has no role, name, or text", () => {
    expect(resolveRef(REFS, { css: "#x" })).toEqual({ ref: undefined, matches: [] });
  });
});

describe("createBrowserAdapter", () => {
  it("opens a tab, fills by css selector, and clicks by resolved ref", async () => {
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      const path = params.path as string;
      if (path === "/tabs/open") {
        return { targetId: "T1" };
      }
      if (path === "/snapshot") {
        return { refs: REFS };
      }
      return { ok: true };
    });
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    expect(await b.open("https://x")).toEqual({ targetId: "T1" });
    await b.fill("T1", { css: "#UserId" }, "ask");
    await b.click("T1", { role: "textbox", name: "User Name" });
    const bodies = request.mock.calls.map(([, p]) => p);
    expect(bodies[0]).toMatchObject({
      method: "POST",
      path: "/tabs/open",
      body: { url: "https://x" },
      query: { profile: "chrome" },
    });
    // The real /act "fill" route only accepts a snapshot ref inside fields (never a raw
    // selector — see extensions/browser/src/browser/form-fields.ts), so a css-only target
    // is filled via the "type" action, which does accept a top-level selector.
    expect(bodies.find((p) => (p.body as { kind?: string })?.kind === "type")?.body).toMatchObject({
      kind: "type",
      selector: "#UserId",
      text: "ask",
      targetId: "T1",
    });
    expect(bodies.find((p) => (p.body as { kind?: string })?.kind === "click")?.body).toMatchObject(
      { kind: "click", ref: "e33", targetId: "T1" },
    );
  });

  it("fails clearly when a target cannot be resolved", async () => {
    const request = vi.fn(async () => ({ refs: REFS }));
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await expect(b.click("T1", { role: "button", name: "Sign-in" })).rejects.toThrow(
      /2 matches|ambiguous/u,
    );
    await expect(b.click("T1", { role: "button", name: "Nope" })).rejects.toThrow(/not found/u);
  });

  it("checks css visibility via a real /act wait probe, not the locate short-circuit", async () => {
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      const body = params.body as { kind?: string; selector?: string } | undefined;
      if (body?.kind === "wait" && body.selector === "#missing") {
        throw new Error("timed out");
      }
      return { ok: true };
    });
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    expect(await b.isVisible("T1", { css: "#present" })).toBe(true);
    expect(await b.isVisible("T1", { css: "#missing" })).toBe(false);
    const waitBody = request.mock.calls.find(
      ([, p]) => (p.body as { kind?: string; selector?: string })?.selector === "#present",
    )?.[1] as { body: Record<string, unknown> } | undefined;
    expect(waitBody?.body).toMatchObject({ kind: "wait", selector: "#present", timeoutMs: 1500 });
  });

  it("resolves role/name/text visibility strictly from resolveRef's match count", async () => {
    const request = vi.fn(async () => ({ refs: REFS }));
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    expect(await b.isVisible("T1", { role: "textbox", name: "User Name" })).toBe(true);
    expect(await b.isVisible("T1", { role: "button", name: "Sign-in" })).toBe(false); // ambiguous
    expect(await b.isVisible("T1", { role: "button", name: "Nope" })).toBe(false); // not found
  });

  it("falls back to an unfiltered snapshot when the interactive one has no match", async () => {
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      const path = params.path as string;
      if (path === "/snapshot") {
        const query = params.query as { interactive?: string };
        if (query.interactive === "true") {
          return { refs: {} };
        }
        return { refs: { h1: { role: "heading", name: "Welcome" } } };
      }
      return { ok: true };
    });
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await b.click("T1", { role: "heading", name: "Welcome" });
    const snapshotCalls = request.mock.calls.filter(
      ([, p]) => (p as { path?: string }).path === "/snapshot",
    );
    expect(snapshotCalls).toHaveLength(2);
    expect(
      (snapshotCalls[0]?.[1] as { query: { interactive?: string } } | undefined)?.query.interactive,
    ).toBe("true");
    expect(snapshotCalls[1]?.[1]).not.toHaveProperty("query.interactive");
    const clickBody = request.mock.calls.find(
      ([, p]) => (p.body as { kind?: string })?.kind === "click",
    )?.[1] as { body: { ref?: string } } | undefined;
    expect(clickBody?.body.ref).toBe("h1");
  });

  it("does not leak the /act envelope when evaluate's result is null or absent", async () => {
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      const body = params.body as { kind?: string; fn?: string } | undefined;
      if (body?.kind === "evaluate" && body.fn === "() => null") {
        return { ok: true, targetId: "T1", url: "https://x", result: null };
      }
      if (body?.kind === "evaluate") {
        return { ok: true, targetId: "T1", url: "https://x" };
      }
      return { ok: true };
    });
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    expect(await b.evaluate("T1", "() => null")).toBeNull();
    expect(await b.evaluate("T1", "() => undefined")).toBeUndefined();
  });

  it("labels the tab it opens with the duty it is replaying", async () => {
    const request = vi.fn(async (_m: string, _params: Record<string, unknown>) => ({
      targetId: "T1",
    }));
    const b = createBrowserAdapter({
      request: asRequest(request),
      profile: "chrome",
      tabLabel: "duty:book-flight",
    });
    await b.open("https://x");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      path: "/tabs/open",
      body: { url: "https://x", label: "duty:book-flight" },
    });
  });

  it("carries the authored wait budget into the act body and the request timeout", async () => {
    const request = vi.fn(async (_m: string, _params: Record<string, unknown>) => ({ ok: true }));
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await b.waitFor("T1", { text: "Booked", timeoutMs: 60_000 });
    const [, params] = request.mock.calls[0]!;
    expect(params).toMatchObject({
      timeoutMs: 65_000,
      body: { kind: "wait", text: "Booked", timeoutMs: 60_000, targetId: "T1" },
    });
  });

  it("carries a step's budget into an acting verb's request timeout", async () => {
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) =>
      (params.path as string) === "/snapshot" ? { refs: REFS } : { ok: true },
    );
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await b.click("T1", { role: "textbox", name: "User Name" }, 45_000);
    const clickCall = request.mock.calls.find(
      ([, p]) => ((p.body as { kind?: string }) ?? {}).kind === "click",
    )?.[1];
    expect(clickCall).toMatchObject({ timeoutMs: 45_000 });

    request.mockClear();
    await b.navigate("T1", "https://x", 45_000);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ path: "/navigate", timeoutMs: 45_000 });
  });

  it("rethrows a transport failure from a css visibility probe instead of reporting not visible", async () => {
    const request = vi.fn(async () => {
      throw new Error("browser.request failed: connectOverCDP: Timeout 9000ms exceeded");
    });
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await expect(b.isVisible("T1", { css: "#account" })).rejects.toThrow(/connectOverCDP/u);
  });

  it("retries an idempotent read once on a transport failure and reports the retry", async () => {
    let snapshots = 0;
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      if ((params.path as string) !== "/snapshot") {
        return { ok: true };
      }
      snapshots += 1;
      if (snapshots === 1) {
        throw new Error("connectOverCDP: Timeout 9000ms exceeded");
      }
      return { refs: REFS };
    });
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await b.click("T1", { role: "textbox", name: "User Name" });
    expect(snapshots).toBe(2);
    expect(b.drainRetryNotes?.()).toEqual(["retried snapshot once"]);
    expect(b.drainRetryNotes?.()).toEqual([]);
  });

  it("does not retry a read whose failure is a page-side wait timeout", async () => {
    let snapshots = 0;
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      if ((params.path as string) !== "/snapshot") {
        return { ok: true };
      }
      snapshots += 1;
      throw new Error("act wait timed out after 20000ms");
    });
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await expect(b.click("T1", { role: "textbox", name: "User Name" })).rejects.toThrow(
      /timed out/u,
    );
    expect(snapshots).toBe(1);
    expect(b.drainRetryNotes?.()).toEqual([]);
  });

  it("never retries a click, fill or navigate", async () => {
    let navigates = 0;
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      if ((params.path as string) === "/navigate") {
        navigates += 1;
        throw new Error("ECONNRESET");
      }
      return { ok: true };
    });
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await expect(b.navigate("T1", "https://x")).rejects.toThrow(/ECONNRESET/u);
    expect(navigates).toBe(1);
  });

  it("prints a tab to pdf and returns the path the browser plugin wrote", async () => {
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) =>
      (params.path as string) === "/pdf"
        ? { ok: true, path: "/tmp/out.pdf", targetId: "T1" }
        : { ok: true },
    );
    const b = createBrowserAdapter({ request: asRequest(request), profile: "openclaw" });
    expect(await b.pdf("T1")).toBe("/tmp/out.pdf");
    expect(
      request.mock.calls.find(([, p]) => (p as { path?: string }).path === "/pdf")?.[1],
    ).toMatchObject({ method: "POST", body: { targetId: "T1" } });
  });

  it("maps an unconditional waitFor to a single timed wait action", async () => {
    const request = vi.fn(async (_m: string, _params: Record<string, unknown>) => ({ ok: true }));
    const b = createBrowserAdapter({ request: asRequest(request), profile: "chrome" });
    await b.waitFor("T1", {});
    let waitBody = request.mock.calls.find(
      ([, p]) => (p.body as { kind?: string })?.kind === "wait",
    )?.[1] as { body: Record<string, unknown> } | undefined;
    expect(waitBody?.body).toMatchObject({ kind: "wait", timeMs: 1000, targetId: "T1" });

    request.mockClear();
    await b.waitFor("T1", { timeoutMs: 5000 });
    waitBody = request.mock.calls.find(
      ([, p]) => (p.body as { kind?: string })?.kind === "wait",
    )?.[1] as { body: Record<string, unknown> } | undefined;
    expect(waitBody?.body).toMatchObject({ kind: "wait", timeMs: 5000, targetId: "T1" });
  });
});
