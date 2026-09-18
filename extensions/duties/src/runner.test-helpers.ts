// Shared fixtures for runner.test.ts and runner-template-deliver.test.ts: a fake RunnerDeps that
// records every side effect as a string, and a minimal Duty builder around a step list.
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duty } from "./duty.js";
import type { RunnerDeps } from "./runner.js";

export function fakeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps & { calls: string[] } {
  const calls: string[] = [];
  const browser: RunnerDeps["browser"] = {
    open: async (url) => {
      calls.push(`open ${url}`);
      return { targetId: `t${calls.filter((c) => c.startsWith("open ")).length}` };
    },
    navigate: async (targetId, url) => {
      calls.push(`navigate ${targetId} ${url}`);
    },
    isVisible: async () => false,
    click: async (_t, target) => {
      calls.push(`click ${JSON.stringify(target)}`);
    },
    fill: async (_t, target, value) => {
      calls.push(`fill ${target.css} ${value}`);
    },
    select: async () => {},
    press: async (_t, key) => {
      calls.push(`press ${key}`);
    },
    waitFor: async () => {},
    text: async () => "Welcome Ask !",
    url: async () => "https://x/Home/Dashboard",
    evaluate: async (_t, fn) => {
      calls.push(`evaluate ${fn}`);
      return 42;
    },
    screenshot: async () => "blob-1",
    screenshotPath: async () => "/tmp/fake.png",
    close: async (id) => {
      calls.push(`close ${id}`);
    },
    pdf: async () => "/tmp/fake.pdf",
  };
  return {
    calls,
    browser: { ...browser, ...over.browser },
    ai: over.ai ?? { extract: async () => ({ origin: "IXU", destination: "COK" }) },
    ask: over.ask ?? { ask: async () => ({ status: "answered", answer: "LIC Nagpur" }) },
    cred: over.cred ?? (async (key) => `cred(${key})`),
    now: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
    templates: over.templates ?? { get: async () => undefined, brand: async () => undefined },
    render: over.render ?? {
      toPdf: async (html, dest) => {
        calls.push(`render ${html}`);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, "%PDF");
        return { bytes: 4 };
      },
    },
    deliver: over.deliver ?? {
      send: async ({ route, text, files }) => {
        const names = (files ?? []).map((f) => path.basename(f)).join(", ");
        calls.push(`deliver ${route.channel}:${route.to} ${text ?? ""} [${names}]`);
        return { messageIds: ["m-1"] };
      },
    },
    resolveRoute:
      over.resolveRoute ??
      (async (_to, _channel, origin) => {
        if (origin?.kind === "chat") {
          return [{ channel: "telegram", to: "222" }];
        }
        throw new Error("no owner target configured — set it on the Duties page");
      }),
    filesDir: over.filesDir ?? mkdtempSync(path.join(tmpdir(), "duties-runner-")),
    // Conditional so the default stays "no cancellation hook" rather than an explicit undefined.
    ...(over.isCancelled ? { isCancelled: over.isCancelled } : {}),
  };
}

export const duty = (steps: Duty["steps"]): Duty => ({
  id: "d",
  name: "D",
  summary: "",
  status: "active",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [{ name: "mail", source: "trigger" }],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
  steps,
});
