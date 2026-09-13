import { describe, expect, it, vi } from "vitest";
import { createBrowserAdapter, resolveRef } from "./browser.js";

const SNAP = `- textbox "User Name" [ref=e33]\n- textbox "Password" [ref=e35]\n- button "Sign-in" [ref=e37]\n- button "Sign-in" [ref=e40]\n- link "Forgot your password?" [ref=e38]`;

describe("resolveRef", () => {
  it("matches role + name exactly and refuses ambiguous matches", () => {
    expect(resolveRef(SNAP, { role: "textbox", name: "User Name" })).toBe("e33");
    expect(resolveRef(SNAP, { role: "button", name: "Sign-in" })).toBeUndefined();
    expect(resolveRef(SNAP, { text: "forgot" })).toBe("e38");
  });
});

describe("createBrowserAdapter", () => {
  it("opens a tab, fills by css selector, and clicks by resolved ref", async () => {
    const request = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      const path = params.path as string;
      if (path === "/tabs/open") return { targetId: "T1" };
      if (path === "/snapshot") return { snapshot: SNAP };
      return { ok: true };
    });
    const b = createBrowserAdapter({ request, profile: "chrome" });
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
    const request = vi.fn(async () => ({ snapshot: SNAP }));
    const b = createBrowserAdapter({ request, profile: "chrome" });
    await expect(b.click("T1", { role: "button", name: "Sign-in" })).rejects.toThrow(
      /2 matches|ambiguous/u,
    );
    await expect(b.click("T1", { role: "button", name: "Nope" })).rejects.toThrow(/not found/u);
  });
});
