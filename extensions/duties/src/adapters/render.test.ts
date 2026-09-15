import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRenderAdapter, createRenderServer, RENDER_MARKER_NAME } from "./render.js";

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
    expect(first.body).toContain("<h1>hi</h1>");
    const second = fakeRes();
    server.handler(req(`/plugins/duties/render/${token}`), second);
    expect(second.statusCode).toBe(404);
    const { token: t2 } = server.publish("<p>late</p>");
    now += 61_000;
    const third = fakeRes();
    server.handler(req(`/plugins/duties/render/${t2}`), third);
    expect(third.statusCode).toBe(404);
  });

  it("embeds the token as a marker meta tag so the printed page can be proven to be this one", () => {
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    const { token } = server.publish("<h1>hi</h1>");
    // SAFETY: only `url` is read from the request.
    const req = (u: string) =>
      ({ url: u, method: "GET" }) as unknown as import("node:http").IncomingMessage;
    const res = fakeRes();
    server.handler(req(`/plugins/duties/render/${token}`), res);
    expect(res.body).toContain(`<meta name="${RENDER_MARKER_NAME}" content="${token}">`);
  });
});

describe("createRenderAdapter", () => {
  it("verifies the marker, prints, copies the pdf to dest, saves a png preview and closes the tab", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-render-"));
    const produced = path.join(dir, "browser-out.pdf");
    await writeFile(produced, "%PDF-1.4 fake");
    const shot = path.join(dir, "browser-shot.png");
    await writeFile(shot, "PNG-BYTES");
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    let token = "";
    const publish = server.publish.bind(server);
    vi.spyOn(server, "publish").mockImplementation((html: string) => {
      const result = publish(html);
      token = result.token;
      return result;
    });
    const browser = {
      open: vi.fn(async (_url: string, _timeoutMs?: number) => ({ targetId: "T9" })),
      evaluate: vi.fn(async () => ({ marker: token, title: "", text: "" })),
      text: vi.fn(async () => ""),
      pdf: vi.fn(async () => produced),
      screenshotPath: vi.fn(async () => shot),
      close: vi.fn(async () => undefined),
    };
    const adapter = createRenderAdapter({ server, browser });
    const dest = path.join(dir, "out", "t1.pdf");
    const result = await adapter.toPdf("<h1>x</h1>", dest);
    expect(result.bytes).toBe(13);
    expect(await readFile(dest, "utf8")).toBe("%PDF-1.4 fake");
    expect(result.previewPath).toBe(path.join(dir, "out", "t1.png"));
    expect(await readFile(result.previewPath!, "utf8")).toBe("PNG-BYTES");
    expect(browser.open.mock.calls[0]?.[0]).toMatch(
      /^http:\/\/127\.0\.0\.1:19001\/plugins\/duties\/render\//u,
    );
    expect(browser.evaluate).toHaveBeenCalled();
    expect(browser.pdf).toHaveBeenCalledWith("T9");
    expect(browser.close).toHaveBeenCalledWith("T9");
  });

  it("names a JPEG-normalised preview capture .jpg instead of assuming .png", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-render-"));
    const produced = path.join(dir, "browser-out.pdf");
    await writeFile(produced, "%PDF-1.4 fake");
    const shot = path.join(dir, "browser-shot.jpg");
    await writeFile(shot, "JPEG-BYTES");
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    let token = "";
    const publish = server.publish.bind(server);
    vi.spyOn(server, "publish").mockImplementation((html: string) => {
      const result = publish(html);
      token = result.token;
      return result;
    });
    const browser = {
      open: vi.fn(async (_url: string, _timeoutMs?: number) => ({ targetId: "T9" })),
      evaluate: vi.fn(async () => ({ marker: token, title: "", text: "" })),
      text: vi.fn(async () => ""),
      pdf: vi.fn(async () => produced),
      screenshotPath: vi.fn(async () => shot),
      close: vi.fn(async () => undefined),
    };
    const adapter = createRenderAdapter({ server, browser });
    const dest = path.join(dir, "out", "t1.pdf");
    const result = await adapter.toPdf("<h1>x</h1>", dest);
    expect(result.previewPath).toBe(path.join(dir, "out", "t1.jpg"));
    expect(await readFile(result.previewPath!, "utf8")).toBe("JPEG-BYTES");
  });

  it("refuses to print a page that is not the published document, and closes the tab", async () => {
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    const browser = {
      open: vi.fn(async (_url: string, _timeoutMs?: number) => ({ targetId: "T9" })),
      // A second Gateway owning the port, an expired token, or an interstitial: a real page with
      // no marker of ours.
      evaluate: vi.fn(async () => ({ marker: "", title: "404 Not Found", text: "Cannot GET" })),
      text: vi.fn(async () => "404 Not Found"),
      pdf: vi.fn(async () => "/never"),
      screenshotPath: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const failure = await createRenderAdapter({ server, browser })
      .toPdf("<p/>", "/nonexistent/x.pdf")
      .catch((error: unknown) => error);
    if (!(failure instanceof Error)) {
      throw new Error("toPdf should have rejected");
    }
    expect(failure.message).toMatch(
      /^render page not served at http:\/\/127\.0\.0\.1:19001\/plugins\/duties\/render\/[0-9a-f-]+ \(got 404 Not Found\)$/u,
    );
    expect(browser.pdf).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledWith("T9");
  });

  it("falls back to the page text when the marker probe itself cannot run", async () => {
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    const browser = {
      open: vi.fn(async (_url: string, _timeoutMs?: number) => ({ targetId: "T9" })),
      evaluate: vi.fn(async () => {
        throw new Error("evaluate unsupported on this profile");
      }),
      text: vi.fn(async () => "  Sign in to continue  "),
      pdf: vi.fn(async () => "/never"),
      screenshotPath: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const failure = await createRenderAdapter({ server, browser })
      .toPdf("<p/>", "/nonexistent/x.pdf")
      .catch((error: unknown) => error);
    if (!(failure instanceof Error)) {
      throw new Error("toPdf should have rejected");
    }
    expect(failure.message).toContain("(got Sign in to continue)");
    expect(browser.pdf).not.toHaveBeenCalled();
  });

  it("still returns the pdf when the preview screenshot cannot be taken", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "duties-render-"));
    const produced = path.join(dir, "browser-out.pdf");
    await writeFile(produced, "%PDF-1.4 fake");
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    let token = "";
    const publish = server.publish.bind(server);
    vi.spyOn(server, "publish").mockImplementation((html: string) => {
      const result = publish(html);
      token = result.token;
      return result;
    });
    const browser = {
      open: vi.fn(async (_url: string, _timeoutMs?: number) => ({ targetId: "T9" })),
      evaluate: vi.fn(async () => ({ marker: token, title: "", text: "" })),
      text: vi.fn(async () => ""),
      pdf: vi.fn(async () => produced),
      screenshotPath: vi.fn(async () => {
        throw new Error("screenshot unsupported");
      }),
      close: vi.fn(async () => undefined),
    };
    const dest = path.join(dir, "out", "t2.pdf");
    const result = await createRenderAdapter({ server, browser }).toPdf("<h1>x</h1>", dest);
    expect(result.bytes).toBe(13);
    expect(result.previewPath).toBeUndefined();
  });

  it("closes the tab and rethrows when printing fails", async () => {
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    let token = "";
    const publish = server.publish.bind(server);
    vi.spyOn(server, "publish").mockImplementation((html: string) => {
      const result = publish(html);
      token = result.token;
      return result;
    });
    const browser = {
      open: vi.fn(async (_url: string, _timeoutMs?: number) => ({ targetId: "T9" })),
      evaluate: vi.fn(async () => ({ marker: token, title: "", text: "" })),
      text: vi.fn(async () => ""),
      pdf: vi.fn(async () => {
        throw new Error("pdf unsupported on this profile");
      }),
      screenshotPath: vi.fn(async () => undefined),
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
      open: vi.fn(async (_url: string, _timeoutMs?: number) => {
        throw new Error("net::ERR_CONNECTION_REFUSED");
      }),
      evaluate: vi.fn(async () => ({ marker: "", title: "", text: "" })),
      text: vi.fn(async () => ""),
      pdf: vi.fn(async () => "/never"),
      screenshotPath: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const failure = await createRenderAdapter({ server, browser })
      .toPdf("<p/>", "/nonexistent/x.pdf")
      .catch((error: unknown) => error);
    if (!(failure instanceof Error)) {
      throw new Error("toPdf should have rejected");
    }
    expect(failure.message).toMatch(
      /^could not open the render page at http:\/\/127\.0\.0\.1:19001\/plugins\/duties\/render\/[0-9a-f-]+: net::ERR_CONNECTION_REFUSED$/u,
    );
    expect(failure.cause).toBeInstanceOf(Error);
    // Nothing was opened, so there is no tab to close and no print attempt.
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.pdf).not.toHaveBeenCalled();
  });

  it("names the browser allowlist config key when the navigation guard blocked the loopback page", async () => {
    const server = createRenderServer({ baseUrl: "http://127.0.0.1:19001" });
    const browser = {
      open: vi.fn(async (_url: string, _timeoutMs?: number) => {
        throw new Error("Blocked hostname or private/internal/special-use IP address");
      }),
      evaluate: vi.fn(async () => ({ marker: "", title: "", text: "" })),
      text: vi.fn(async () => ""),
      pdf: vi.fn(async () => "/never"),
      screenshotPath: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const failure = await createRenderAdapter({ server, browser })
      .toPdf("<p/>", "/nonexistent/x.pdf")
      .catch((error: unknown) => error);
    if (!(failure instanceof Error)) {
      throw new Error("toPdf should have rejected");
    }
    expect(failure.message).toContain("browser.ssrfPolicy.allowedHostnames");
    expect(failure.message).toContain("127.0.0.1");
  });
});
