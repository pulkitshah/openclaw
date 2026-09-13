import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRenderAdapter, createRenderServer } from "./render.js";

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    end(b?: string) {
      this.body = b ?? "";
    },
  };
  // SAFETY: the handler only uses statusCode/setHeader/end, which this stub provides.
  return res as unknown as import("node:http").ServerResponse & typeof res;
}

describe("createRenderServer", () => {
  it("serves a published document exactly once, then 404s, and expires by ttl", () => {
    let now = 1_000;
    const server = createRenderServer({
      baseUrl: "http://127.0.0.1:19001",
      ttlMs: 60_000,
      now: () => now,
    });
    const { url, token } = server.publish("<h1>hi</h1>");
    expect(url).toBe(`http://127.0.0.1:19001/plugins/duties/render/${token}`);
    // SAFETY: only `url` is read from the request.
    const req = (u: string) =>
      ({ url: u, method: "GET" }) as unknown as import("node:http").IncomingMessage;
    const first = fakeRes();
    expect(server.handler(req(`/plugins/duties/render/${token}`), first)).toBe(true);
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("<h1>hi</h1>");
    const second = fakeRes();
    server.handler(req(`/plugins/duties/render/${token}`), second);
    expect(second.statusCode).toBe(404);
    const { token: t2 } = server.publish("<p>late</p>");
    now += 61_000;
    const third = fakeRes();
    server.handler(req(`/plugins/duties/render/${t2}`), third);
    expect(third.statusCode).toBe(404);
  });
});

describe("createRenderAdapter", () => {
  it("opens the published url in a tab, prints it, copies the pdf to dest and closes the tab", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-render-"));
    const produced = path.join(dir, "browser-out.pdf");
    await writeFile(produced, "%PDF-1.4 fake");
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    const browser = {
      open: vi.fn(async () => ({ targetId: "T9" })),
      pdf: vi.fn(async () => produced),
      close: vi.fn(async () => undefined),
    };
    const adapter = createRenderAdapter({ server, browser });
    const dest = path.join(dir, "out", "t1.pdf");
    const result = await adapter.toPdf("<h1>x</h1>", dest);
    expect(result.bytes).toBe(13);
    expect(await readFile(dest, "utf8")).toBe("%PDF-1.4 fake");
    expect(browser.open.mock.calls[0]?.[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:19001\/plugins\/duties\/render\//u,
    );
    expect(browser.pdf).toHaveBeenCalledWith("T9");
    expect(browser.close).toHaveBeenCalledWith("T9");
  });
  it("closes the tab and rethrows when printing fails", async () => {
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    const browser = {
      open: vi.fn(async () => ({ targetId: "T9" })),
      pdf: vi.fn(async () => {
        throw new Error("pdf unsupported on this profile");
      }),
      close: vi.fn(async () => undefined),
    };
    await expect(
      createRenderAdapter({ server, browser }).toPdf("<p/>", "/nonexistent/x.pdf"),
    ).rejects.toThrow(/pdf unsupported/u);
    expect(browser.close).toHaveBeenCalledWith("T9");
  });
  it("names the render url when the page cannot be opened, so a wrong scheme or port is not opaque", async () => {
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    const browser = {
      open: vi.fn(async () => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }),
      pdf: vi.fn(async () => "/never"),
      close: vi.fn(async () => undefined),
    };
    const failure = await createRenderAdapter({ server, browser })
      .toPdf("<p/>", "/nonexistent/x.pdf")
      .catch((error: unknown) => error);
    if (!(failure instanceof Error)) throw new Error("toPdf should have rejected");
    expect(failure.message).toMatch(
      /^could not open the render page at http:\/\/127\.0\.0\.1:19001\/plugins\/duties\/render\/[0-9a-f-]+: net::ERR_CONNECTION_REFUSED$/u,
    );
    expect(failure.cause).toBeInstanceOf(Error);
    // Nothing was opened, so there is no tab to close and no print attempt.
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.pdf).not.toHaveBeenCalled();
  });
});
