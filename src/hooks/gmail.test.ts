// Gmail hook tests cover Gmail hook configuration and setup helpers.
import { describe, expect, it } from "vitest";
import { type OpenClawConfig, DEFAULT_GATEWAY_PORT } from "../config/config.js";
import {
  buildDefaultHookUrl,
  buildGogWatchServeArgs,
  buildGogWatchServeLogArgs,
  buildTopicPath,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const baseConfig = {
  hooks: {
    token: "hook-token",
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/demo/topics/gog-gmail-watch",
      pushToken: "push-token",
    },
  },
} satisfies OpenClawConfig;

describe("gmail hook config", () => {
  function resolveWithGmailOverrides(
    overrides: Partial<NonNullable<OpenClawConfig["hooks"]>["gmail"]>,
  ) {
    return resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            ...overrides,
          },
        },
      },
      {},
    );
  }

  function expectResolvedPaths(
    result: ReturnType<typeof resolveGmailHookRuntimeConfig>,
    expected: { servePath: string; publicPath: string; target?: string },
  ) {
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.serve.path).toBe(expected.servePath);
    expect(result.value.tailscale.path).toBe(expected.publicPath);
    if (expected.target !== undefined) {
      expect(result.value.tailscale.target).toBe(expected.target);
    }
  }

  it("builds default hook url", () => {
    expect(buildDefaultHookUrl("/hooks", DEFAULT_GATEWAY_PORT)).toBe(
      `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`,
    );
  });

  it("parses topic path", () => {
    const topic = buildTopicPath("proj", "topic");
    expect(parseTopicPath(topic)).toEqual({
      projectId: "proj",
      topicName: "topic",
    });
  });

  it("resolves runtime config with defaults", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.account).toBe("openclaw@gmail.com");
      expect(result.value.label).toBe("INBOX");
      expect(result.value.includeBody).toBe(true);
      expect(result.value.serve.port).toBe(8788);
      expect(result.value.hookUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`);
    }
  });

  it("builds watch serve log args without secrets", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const serveArgs = buildGogWatchServeArgs(result.value);
    expect(serveArgs).toContain("--exclude-labels");
    expect(serveArgs[serveArgs.indexOf("--exclude-labels") + 1]).toBe("SPAM,TRASH,DRAFT,SENT");

    const args = buildGogWatchServeLogArgs(result.value);
    expect(args).not.toContain("push-token");
    expect(args).not.toContain("hook-token");
    expect(args).not.toContain("--token");
    expect(args).not.toContain("--hook-token");
    // --token, --hook-url, and --hook-token are stripped from the log args.
    expect(args).toEqual([
      "gmail",
      "watch",
      "serve",
      "--account",
      "openclaw@gmail.com",
      "--bind",
      "127.0.0.1",
      "--port",
      "8788",
      "--path",
      "/gmail-pubsub",
      "--include-body",
      "--exclude-labels",
      "SPAM,TRASH,DRAFT,SENT",
      "--max-bytes",
      "20000",
    ]);
  });

  it("fails without hook token", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
  });

  it("defaults serve path to / when tailscale is enabled", () => {
    const result = resolveWithGmailOverrides({ tailscale: { mode: "funnel" } });
    expectResolvedPaths(result, { servePath: "/", publicPath: "/gmail-pubsub" });
  });

  it("keeps the default public path when serve path is explicit", () => {
    const result = resolveWithGmailOverrides({
      serve: { path: "/gmail-pubsub" },
      tailscale: { mode: "funnel" },
    });
    expectResolvedPaths(result, { servePath: "/", publicPath: "/gmail-pubsub" });
  });

  it("keeps custom public path when serve path is set", () => {
    const result = resolveWithGmailOverrides({
      serve: { path: "/custom" },
      tailscale: { mode: "funnel" },
    });
    expectResolvedPaths(result, { servePath: "/", publicPath: "/custom" });
  });

  it("keeps serve path when tailscale target is set", () => {
    const target = "http://127.0.0.1:8788/custom";
    const result = resolveWithGmailOverrides({
      serve: { path: "/custom" },
      tailscale: { mode: "funnel", target },
    });
    expectResolvedPaths(result, { servePath: "/custom", publicPath: "/custom", target });
  });

  it("resolves a single-mailbox config exactly as before, plus accountId default", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.accountId).toBe("default");
    expect(result.value.account).toBe("openclaw@gmail.com");
    expect(result.value.label).toBe("INBOX");
    expect(result.value.subscription).toBe("gog-gmail-watch-push");
    expect(result.value.hookUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`);
    expect(result.value.hookUrl).not.toContain("gmail-");
  });

  it("resolves a named account without inheriting the root address", () => {
    const cfg = {
      hooks: {
        token: "hook-token",
        gmail: {
          account: "root@example.com",
          topic: "projects/demo/topics/gog-gmail-watch",
          pushToken: "push-token",
          accounts: { enquiries: { account: "enquiries@prasthan.in" } },
        },
      },
    } satisfies OpenClawConfig;
    const result = resolveGmailHookRuntimeConfig(cfg, { accountId: "enquiries" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.accountId).toBe("enquiries");
    expect(result.value.account).toBe("enquiries@prasthan.in");
    // Topic and push token ARE shared defaults; the address is not.
    expect(result.value.topic).toBe("projects/demo/topics/gog-gmail-watch");
    expect(result.value.hookUrl).toContain("/gmail-enquiries");
  });

  it("refuses an unknown accountId instead of silently falling back to the root/default account", () => {
    const cfg = {
      hooks: {
        token: "hook-token",
        gmail: {
          account: "root@example.com",
          topic: "projects/demo/topics/gog-gmail-watch",
          pushToken: "push-token",
          accounts: { enquiries: { account: "enquiries@prasthan.in" } },
        },
      },
    } satisfies OpenClawConfig;
    // A typo'd hooks.gmail.defaultAccount (or an explicit bad accountId override) must fail
    // loudly rather than silently watching the root mailbox while posting to a hook path
    // ("/gmail-orders-typo") nothing is mapped to.
    const result = resolveGmailHookRuntimeConfig(cfg, { accountId: "orders-typo" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("orders-typo");
    expect(result.error).not.toContain("root@example.com");
  });
});
