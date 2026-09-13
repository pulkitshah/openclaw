# Duties Core — Part 1 (plugin foundation, runner, tools, UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bundled `duties` plugin in this fork that stores Duties, replays browser/ai/ask/when/stop steps without a model turn, lets the agent author Duties through tools, and shows them in the Control UI — proven on the _Book flight by mail — Amigos_ login + search stages.

**Architecture:** One bundled plugin under `extensions/duties` (Workboard pattern): a keyed-store backed `DutyStore`, a pure `runDuty()` runner with injected adapters, adapters that reach OpenClaw through `api.runtime.gateway.request` (`browser.request`, `tools.invoke`, `question.request`/`question.waitAnswer`), Gateway methods `duties.*` plus `plugin.duties.changed` events, agent tools `duty_*`, and a browser bundle registering the sidebar page. Part 2 (separate plan) adds templates, deliver, mcp, file/print, repair, schedule and mail triggers.

**Tech Stack:** TypeScript ESM, `openclaw/plugin-sdk/*` only, TypeBox for schemas, Vitest (`node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts <files>`), `openclaw plugins build` for the browser bundle (esbuild).

**Spec:** `docs/superpowers/specs/2026-09-13-duties-core-design.md`

## Global Constraints

- Node `>=24.16.0 <25 || >=26.1.0`; use `export PATH="$HOME/.nvm/versions/node/v26.8.2/bin:$PATH"` in every shell.
- Install only with: `npm_config_minimum_release_age=0 npm_config_minimum_release_age_strict=false npx -y pnpm@12.3.4 install --frozen-lockfile --ignore-scripts` (never edit `pnpm-lock.yaml`; never add dependencies without the owner's approval).
- Extension code imports only `openclaw/plugin-sdk/*` and its own files — never `src/**` or another extension's `src/**` (`extensions/AGENTS.md`).
- State lives in the plugin keyed store (SQLite); no JSON sidecar files. Credential **values** never enter the store, logs, chat, or model.
- Duty statuses are exactly `active | paused | building`. No draft, no versions, no step editor, no green-run gate.
- Labels are in the owner's words; targets are durable (`role`/`name`/`text`/`css`), never snapshot refs.
- Run status set is exactly `queued | running | ok | failed | blocked | needs_input | cancelled | lost`.
- Login pages are snapshotted with `interactive=true` so field values are never captured.
- Commit after every task with a Conventional Commit message ending in:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HqBDjTY3KJDDioiMg5wXUy`. Branch: `feat/duties`. `docs/superpowers` is gitignored upstream — use `git add -f` for docs there.

## File structure

```
extensions/duties/
  openclaw.plugin.json          manifest (id duties, skills, contracts.tools)
  package.json                  workspace package; openclaw.controlUi → ./browser/index.ts
  tsconfig.json                 extends ../tsconfig.package-boundary.base.json
  api.ts                        re-exports definePluginEntry + types (public barrel)
  index.ts                      register(api): store, methods, tools, service, descriptor
  src/duty.ts                   Duty/Step/Run types, validateDuty, resolvePlaceholders
  src/store.ts                  DutyStore over keyed stores (duties, runs)
  src/creds.ts                  OS keychain get/set (macOS `security`, Windows PowerShell)
  src/runner.ts                 runDuty(): walks nodes with injected RunnerDeps
  src/adapters/browser.ts       RunnerDeps.browser via gateway "browser.request"
  src/adapters/ai.ts            RunnerDeps.ai via gateway "tools.invoke" → llm-task
  src/adapters/ask.ts           RunnerDeps.ask via "question.request" + "question.waitAnswer"
  src/run-service.ts            RunManager: concurrency locks, run records, events
  src/gateway-methods.ts        duties.list/get/save/delete/run/runs.list/run.get
  src/tools.ts                  duty_list/get/draft/set_steps/run/save, cred_needed
  skills/duties/SKILL.md        authoring loop for the agent
  browser/index.ts, browser/styles.css   Control UI page (from the spike)
  *.test.ts next to each source file
```

---

### Task 1: Plugin skeleton that loads, with a registration test

**Files:**

- Create: `extensions/duties/openclaw.plugin.json`, `extensions/duties/package.json`, `extensions/duties/tsconfig.json`, `extensions/duties/api.ts`, `extensions/duties/index.ts`, `extensions/duties/index.test.ts`

**Interfaces:**

- Produces: default export `{ id: "duties", register(api) }` from `index.ts`; `api.ts` re-exports `definePluginEntry`, `OpenClawPluginApi`, `OpenClawPluginService`.

- [ ] **Step 1: Write the failing registration test**

```ts
// extensions/duties/index.test.ts
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("duties plugin registration", () => {
  it("registers the sidebar tab descriptor", () => {
    const captured = capturePluginRegistration({
      id: "duties",
      name: "Duties",
      register: plugin.register,
    });
    expect(captured.controlUiDescriptors).toContainEqual({
      surface: "tab",
      id: "duties",
      label: "Duties",
      icon: "listChecks",
      group: "control",
      requiredScopes: ["operator.read"],
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/duties/index.test.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Create the package files**

```json
// extensions/duties/openclaw.plugin.json
{
  "id": "duties",
  "name": "Duties",
  "description": "Saved, replayable automations the agent authors from your instructions.",
  "categories": ["other"],
  "activation": { "onStartup": true },
  "contracts": {
    "tools": [
      "duty_list",
      "duty_get",
      "duty_draft",
      "duty_set_steps",
      "duty_run",
      "duty_save",
      "cred_needed"
    ]
  },
  "skills": ["./skills"],
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

```json
// extensions/duties/package.json
{
  "name": "@openclaw/duties",
  "version": "2026.9.4",
  "private": true,
  "description": "OpenClaw Duties plugin",
  "type": "module",
  "dependencies": { "typebox": "1.3.27" },
  "devDependencies": { "@openclaw/plugin-sdk": "workspace:*", "openclaw": "workspace:*" },
  "peerDependencies": { "openclaw": ">=2026.9.4" },
  "peerDependenciesMeta": { "openclaw": { "optional": true } },
  "openclaw": {
    "extensions": ["./index.ts"],
    "controlUi": "./browser/index.ts",
    "assetScripts": {
      "build": "node --import ../../scripts/tsx.mjs ../../scripts/build-plugin-control-ui.mts",
      "copy": "node --import ../../scripts/tsx.mjs ../../scripts/build-plugin-control-ui.mts --copy",
      "buildOutputs": ["openclaw.plugin.json"]
    }
  }
}
```

```json
// extensions/duties/tsconfig.json
{ "extends": "../tsconfig.package-boundary.base.json" }
```

```ts
// extensions/duties/api.ts
export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginService,
} from "openclaw/plugin-sdk/plugin-entry";
```

```ts
// extensions/duties/index.ts
import { definePluginEntry } from "./api.js";

export default definePluginEntry({
  id: "duties",
  name: "Duties",
  description: "Saved, replayable automations the agent authors from your instructions.",
  register(api) {
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "duties",
      label: "Duties",
      icon: "listChecks",
      group: "control",
      requiredScopes: ["operator.read"],
    });
  },
});
```

The typebox version must match the one already in the lockfile (`extensions/workboard/package.json` pins `1.3.27`); the frozen install accepts a new workspace package only if every dependency already resolves in the lockfile. Re-run the install command from Global Constraints after adding the package.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/duties/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extensions/duties
git commit -m "feat(duties): plugin skeleton with sidebar descriptor"
```

---

### Task 2: Duty document — types, validation, placeholders

**Files:**

- Create: `extensions/duties/src/duty.ts`, `extensions/duties/src/duty.test.ts`

**Interfaces:**

- Produces:
  - `type DutyStatus = "active" | "paused" | "building"`
  - `type Target = { role?: string; name?: string; text?: string; css?: string }`
  - `type Check = { visible?: Target; text_matches?: string; url_matches?: string; non_empty?: string; attribute?: { target: Target; name: string } }`
  - `type Step = { id: string; kind: "browser" | "browser.evaluate" | "ai" | "ask"; label: string; params: Record<string, unknown>; target?: Target; check?: Check; saveAs?: string | string[]; timeoutMs?: number }`
  - `type WhenNode = { kind: "when"; label: string; cond: Cond; then: DutyNode[]; else?: DutyNode[] }`, `type StopNode = { kind: "stop"; label: string; reason: string }`, `type DutyNode = Step | WhenNode | StopNode`
  - `type Cond = { visible: Target } | { equals: [string, string] } | { text_matches: string }`
  - `type DutyInput = { name: string; source: "ask" | "file" | "trigger" | "cred" | "literal"; prompt?: string; value?: string }`
  - `type Duty = { id: string; name: string; summary: string; status: DutyStatus; machine: string; reportsTo: string; exclusive?: boolean; inputs: DutyInput[]; steps: DutyNode[]; triggers: Array<{ kind: "manual" | "webhook"; secret?: string }>; updatedAt: number; lastRunAt?: number }`
  - `validateDuty(input: unknown): { ok: true; duty: Duty } | { ok: false; errors: string[] }`
  - `resolvePlaceholders(value: string, ctx: { out: Record<string, unknown>; in: Record<string, unknown>; cred?: (key: string) => Promise<string> }): Promise<string>` — replaces `{{out:x}}`, `{{in:x}}`, `{{cred:x}}`; unknown `out`/`in` → empty string; unknown `cred` throws `Error("no credential stored for <key>")`.

- [ ] **Step 1: Write the failing tests**

```ts
// extensions/duties/src/duty.test.ts
import { describe, expect, it } from "vitest";
import { resolvePlaceholders, validateDuty } from "./duty.js";

const base = {
  id: "book-flight",
  name: "Book flight",
  summary: "Books a flight",
  status: "building",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
  steps: [
    {
      id: "s1",
      kind: "browser",
      label: "Open Amigos",
      params: { action: "open", url: "https://amigosalliance.co.in" },
    },
    {
      kind: "when",
      label: "If signed out, sign in",
      cond: { visible: { role: "textbox", name: "User Name" } },
      then: [
        {
          id: "s2",
          kind: "browser",
          label: "Fill username",
          params: { action: "fill", value: "{{cred:amigos.username}}" },
          target: { css: "#UserId" },
        },
      ],
    },
    { kind: "stop", label: "Nothing to book", reason: "Mail was not a booking request" },
  ],
};

describe("validateDuty", () => {
  it("accepts a well-formed duty", () => {
    const result = validateDuty(base);
    expect(result.ok).toBe(true);
  });
  it("rejects a step whose label is a selector, an unknown kind, and a draft status", () => {
    const bad = {
      ...base,
      status: "draft",
      steps: [{ id: "x", kind: "magic", label: "#btnlogin", params: {} }],
    };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("status"),
          expect.stringContaining("kind"),
          expect.stringContaining("label"),
        ]),
      );
    }
  });
  it("rejects duplicate step ids", () => {
    const dup = { ...base, steps: [base.steps[0], base.steps[0]] };
    expect(validateDuty(dup).ok).toBe(false);
  });
});

describe("resolvePlaceholders", () => {
  it("fills out/in and resolves cred through the getter", async () => {
    const out = await resolvePlaceholders("{{in:city}} → {{out:code}} / {{cred:k}}", {
      out: { code: "COK" },
      in: { city: "Kochi" },
      cred: async (key) => `secret-${key}`,
    });
    expect(out).toBe("Kochi → COK / secret-k");
  });
  it("throws for an unknown credential so placeholder text never reaches a form", async () => {
    await expect(
      resolvePlaceholders("{{cred:missing}}", {
        out: {},
        in: {},
        cred: async () => {
          throw new Error("no credential stored for missing");
        },
      }),
    ).rejects.toThrow("no credential stored for missing");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/duties/src/duty.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `duty.ts`**

```ts
// extensions/duties/src/duty.ts
export type DutyStatus = "active" | "paused" | "building";
export const DUTY_STATUSES: readonly DutyStatus[] = ["active", "paused", "building"];
export type Target = { role?: string; name?: string; text?: string; css?: string };
export type Check = {
  visible?: Target;
  text_matches?: string;
  url_matches?: string;
  non_empty?: string;
  attribute?: { target: Target; name: string };
};
export type StepKind = "browser" | "browser.evaluate" | "ai" | "ask";
export const STEP_KINDS: readonly StepKind[] = ["browser", "browser.evaluate", "ai", "ask"];
export type Step = {
  id: string;
  kind: StepKind;
  label: string;
  params: Record<string, unknown>;
  target?: Target;
  check?: Check;
  saveAs?: string | string[];
  timeoutMs?: number;
};
export type Cond = { visible: Target } | { equals: [string, string] } | { text_matches: string };
export type WhenNode = {
  kind: "when";
  label: string;
  cond: Cond;
  then: DutyNode[];
  else?: DutyNode[];
};
export type StopNode = { kind: "stop"; label: string; reason: string };
export type DutyNode = Step | WhenNode | StopNode;
export type DutyInput = {
  name: string;
  source: "ask" | "file" | "trigger" | "cred" | "literal";
  prompt?: string;
  value?: string;
};
export type DutyTrigger = { kind: "manual" | "webhook"; secret?: string };
export type Duty = {
  id: string;
  name: string;
  summary: string;
  status: DutyStatus;
  machine: string;
  reportsTo: string;
  exclusive?: boolean;
  inputs: DutyInput[];
  steps: DutyNode[];
  triggers: DutyTrigger[];
  updatedAt: number;
  lastRunAt?: number;
};

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SELECTOR_LABEL_RE = /^[#.[]|^role=|^css=/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTarget(target: unknown, path: string, errors: string[]): void {
  if (!isRecord(target)) {
    errors.push(`${path}: target must be an object`);
    return;
  }
  if (!["role", "name", "text", "css"].some((k) => typeof target[k] === "string" && target[k])) {
    errors.push(`${path}: target needs at least one of role, name, text, css`);
  }
}

function validateNodes(nodes: unknown, path: string, errors: string[], seenIds: Set<string>): void {
  if (!Array.isArray(nodes)) {
    errors.push(`${path}: steps must be an array`);
    return;
  }
  nodes.forEach((node, index) => {
    const p = `${path}[${index}]`;
    if (!isRecord(node)) {
      errors.push(`${p}: must be an object`);
      return;
    }
    if (typeof node.label !== "string" || !node.label.trim()) {
      errors.push(`${p}: label is required`);
    } else if (SELECTOR_LABEL_RE.test(node.label.trim())) {
      errors.push(`${p}: label must be in the owner's words, not a selector`);
    }
    if (node.kind === "when") {
      if (!isRecord(node.cond)) errors.push(`${p}: when needs a cond`);
      validateNodes(node.then, `${p}.then`, errors, seenIds);
      if (node.else !== undefined) validateNodes(node.else, `${p}.else`, errors, seenIds);
      return;
    }
    if (node.kind === "stop") {
      if (typeof node.reason !== "string" || !node.reason.trim())
        errors.push(`${p}: stop needs a reason`);
      return;
    }
    if (!STEP_KINDS.includes(node.kind as StepKind)) {
      errors.push(`${p}: unknown step kind "${String(node.kind)}"`);
      return;
    }
    if (typeof node.id !== "string" || !node.id) errors.push(`${p}: step id is required`);
    else if (seenIds.has(node.id)) errors.push(`${p}: duplicate step id "${node.id}"`);
    else seenIds.add(node.id);
    if (!isRecord(node.params)) errors.push(`${p}: params must be an object`);
    if (node.target !== undefined) validateTarget(node.target, p, errors);
  });
}

export function validateDuty(
  input: unknown,
): { ok: true; duty: Duty } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["duty must be an object"] };
  if (typeof input.id !== "string" || !ID_RE.test(input.id))
    errors.push("id must be a kebab-case slug");
  if (typeof input.name !== "string" || !input.name.trim()) errors.push("name is required");
  if (typeof input.summary !== "string") errors.push("summary is required");
  if (!DUTY_STATUSES.includes(input.status as DutyStatus))
    errors.push(`status must be one of ${DUTY_STATUSES.join(", ")}`);
  if (typeof input.machine !== "string" || !input.machine) errors.push("machine is required");
  if (typeof input.reportsTo !== "string" || !input.reportsTo) errors.push("reportsTo is required");
  if (!Array.isArray(input.inputs)) errors.push("inputs must be an array");
  if (!Array.isArray(input.triggers)) errors.push("triggers must be an array");
  if (typeof input.updatedAt !== "number") errors.push("updatedAt must be a number");
  validateNodes(input.steps, "steps", errors, new Set());
  return errors.length ? { ok: false, errors } : { ok: true, duty: input as unknown as Duty };
}

const PLACEHOLDER_RE = /\{\{(out|in|cred):([A-Za-z0-9_.-]+)\}\}/gu;

export async function resolvePlaceholders(
  value: string,
  ctx: {
    out: Record<string, unknown>;
    in: Record<string, unknown>;
    cred?: (key: string) => Promise<string>;
  },
): Promise<string> {
  let result = value;
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    const [whole, scope, key] = match;
    let replacement = "";
    if (scope === "out") replacement = stringify(ctx.out[key]);
    else if (scope === "in") replacement = stringify(ctx.in[key]);
    else {
      if (!ctx.cred) throw new Error(`no credential stored for ${key}`);
      replacement = await ctx.cred(key);
    }
    result = result.replaceAll(whole, replacement);
  }
  return result;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function containsCredPlaceholder(value: string): boolean {
  return /\{\{cred:[A-Za-z0-9_.-]+\}\}/u.test(value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/duties/src/duty.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extensions/duties/src/duty.ts extensions/duties/src/duty.test.ts
git commit -m "feat(duties): duty document types, validation, placeholders"
```

---

### Task 3: DutyStore over the plugin keyed store

**Files:**

- Create: `extensions/duties/src/store.ts`, `extensions/duties/src/store.test.ts`

**Interfaces:**

- Consumes: `Duty`, `validateDuty` (Task 2); `PluginStateKeyedStore<T>` from `openclaw/plugin-sdk/plugin-state` — check the exact subpath with `grep -n "plugin-state" scripts/lib/plugin-sdk-entrypoints.json`; if there is none, import the type from `openclaw/plugin-sdk/plugin-entry`'s `OpenClawPluginApi["runtime"]["state"]` return type as shown below.
- Produces:
  - `type RunStatus = "queued" | "running" | "ok" | "failed" | "blocked" | "needs_input" | "cancelled" | "lost"`
  - `type StepEvidence = { stepId: string; label: string; kind: string; status: "ok" | "failed" | "skipped"; durationMs: number; summary: string; target?: string; screenshotBlobId?: string }`
  - `type DutyRun = { id: string; dutyId: string; status: RunStatus; startedAt: number; endedAt?: number; trigger: string; inputs: Record<string, unknown>; outputs: Record<string, unknown>; steps: StepEvidence[]; failedStep?: string; report?: string; waitingOn?: { questionId: string; stepId: string } }`
  - `class DutyStore { static open(api): DutyStore; listDuties(): Promise<Duty[]>; getDuty(id): Promise<Duty | undefined>; saveDuty(duty: Duty): Promise<void>; deleteDuty(id): Promise<boolean>; createRun(run: DutyRun): Promise<void>; updateRun(id, patch: Partial<DutyRun>): Promise<DutyRun | undefined>; getRun(id): Promise<DutyRun | undefined>; listRuns(dutyId, opts?: { onlySuccessful?: boolean; limit?: number }): Promise<DutyRun[]>; markRunningRunsLost(): Promise<number> }`

- [ ] **Step 1: Write the failing tests with an in-memory keyed store**

```ts
// extensions/duties/src/store.test.ts
import { describe, expect, it } from "vitest";
import { DutyStore, type DutyRun } from "./store.js";
import type { Duty } from "./duty.js";

function memoryKeyed<T>() {
  const map = new Map<string, T>();
  return {
    async register(key: string, value: T) {
      map.set(key, value);
    },
    async registerIfAbsent(key: string, value: T) {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
    async update(key: string, fn: (cur: T | undefined) => T | undefined) {
      const next = fn(map.get(key));
      if (next === undefined) return false;
      map.set(key, next);
      return true;
    },
    async lookup(key: string) {
      return map.get(key);
    },
    async consume(key: string) {
      const v = map.get(key);
      map.delete(key);
      return v;
    },
    async delete(key: string) {
      return map.delete(key);
    },
    async entries() {
      return [...map.entries()].map(([key, value]) => ({ key, value }));
    },
    async clear() {
      map.clear();
    },
  };
}

const duty: Duty = {
  id: "d1",
  name: "D1",
  summary: "",
  status: "building",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [],
  steps: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
};
const run = (id: string, status: DutyRun["status"]): DutyRun => ({
  id,
  dutyId: "d1",
  status,
  startedAt: Number(id.slice(1)),
  trigger: "manual",
  inputs: {},
  outputs: {},
  steps: [],
});

describe("DutyStore", () => {
  const store = new DutyStore({ duties: memoryKeyed(), runs: memoryKeyed() });
  it("saves, lists, gets and deletes duties", async () => {
    await store.saveDuty(duty);
    expect((await store.listDuties()).map((d) => d.id)).toEqual(["d1"]);
    expect((await store.getDuty("d1"))?.name).toBe("D1");
    expect(await store.deleteDuty("d1")).toBe(true);
    expect(await store.listDuties()).toEqual([]);
  });
  it("lists runs newest first and can filter to successful ones", async () => {
    await store.createRun(run("r1", "ok"));
    await store.createRun(run("r2", "failed"));
    await store.createRun(run("r3", "ok"));
    expect((await store.listRuns("d1")).map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
    expect((await store.listRuns("d1", { onlySuccessful: true })).map((r) => r.id)).toEqual([
      "r3",
      "r1",
    ]);
  });
  it("patches a run and marks running runs lost", async () => {
    await store.createRun(run("r4", "running"));
    expect((await store.updateRun("r4", { report: "x" }))?.report).toBe("x");
    expect(await store.markRunningRunsLost()).toBe(1);
    expect((await store.getRun("r4"))?.status).toBe("lost");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `node scripts/run-vitest.mjs run --config test/vitest/vitest.extensions.config.ts extensions/duties/src/store.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `store.ts`**

```ts
// extensions/duties/src/store.ts
import type { OpenClawPluginApi } from "../api.js";
import type { Duty } from "./duty.js";

export type RunStatus =
  "queued" | "running" | "ok" | "failed" | "blocked" | "needs_input" | "cancelled" | "lost";
export type StepEvidence = {
  stepId: string;
  label: string;
  kind: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  summary: string;
  target?: string;
  screenshotBlobId?: string;
};
export type DutyRun = {
  id: string;
  dutyId: string;
  status: RunStatus;
  startedAt: number;
  endedAt?: number;
  trigger: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  steps: StepEvidence[];
  failedStep?: string;
  report?: string;
  waitingOn?: { questionId: string; stepId: string };
};

type Keyed<T> =
  ReturnType<OpenClawPluginApi["runtime"]["state"]["openKeyedStore"]> extends infer S
    ? S extends { lookup: (key: string) => Promise<unknown> }
      ? Omit<S, "lookup" | "entries" | "register" | "update"> & {
          register(key: string, value: T): Promise<void>;
          update?: (key: string, fn: (cur: T | undefined) => T | undefined) => Promise<boolean>;
          lookup(key: string): Promise<T | undefined>;
          entries(): Promise<Array<{ key: string; value: T }>>;
          delete(key: string): Promise<boolean>;
        }
      : never
    : never;

export type DutyStores = { duties: Keyed<Duty>; runs: Keyed<DutyRun> };

export class DutyStore {
  constructor(private readonly stores: DutyStores) {}

  static open(api: OpenClawPluginApi): DutyStore {
    return new DutyStore({
      duties: api.runtime.state.openKeyedStore<Duty>({
        namespace: "duties",
        maxEntries: 5_000,
        overflowPolicy: "reject-new",
      }) as unknown as Keyed<Duty>,
      runs: api.runtime.state.openKeyedStore<DutyRun>({
        namespace: "runs",
        maxEntries: 50_000,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: 90 * 24 * 3600 * 1000,
      }) as unknown as Keyed<DutyRun>,
    });
  }

  async listDuties(): Promise<Duty[]> {
    const entries = await this.stores.duties.entries();
    return entries.map((e) => e.value).toSorted((a, b) => a.name.localeCompare(b.name));
  }
  getDuty(id: string) {
    return this.stores.duties.lookup(id);
  }
  saveDuty(duty: Duty) {
    return this.stores.duties.register(duty.id, duty);
  }
  deleteDuty(id: string) {
    return this.stores.duties.delete(id);
  }

  createRun(run: DutyRun) {
    return this.stores.runs.register(run.id, run);
  }
  getRun(id: string) {
    return this.stores.runs.lookup(id);
  }
  async updateRun(id: string, patch: Partial<DutyRun>): Promise<DutyRun | undefined> {
    const current = await this.stores.runs.lookup(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    await this.stores.runs.register(id, next);
    return next;
  }
  async listRuns(
    dutyId: string,
    opts?: { onlySuccessful?: boolean; limit?: number },
  ): Promise<DutyRun[]> {
    const entries = await this.stores.runs.entries();
    return entries
      .map((e) => e.value)
      .filter((r) => r.dutyId === dutyId && (!opts?.onlySuccessful || r.status === "ok"))
      .toSorted((a, b) => b.startedAt - a.startedAt)
      .slice(0, opts?.limit ?? 50);
  }
  async markRunningRunsLost(): Promise<number> {
    const entries = await this.stores.runs.entries();
    let count = 0;
    for (const { key, value } of entries) {
      if (value.status === "running" || value.status === "queued") {
        await this.stores.runs.register(key, { ...value, status: "lost", endedAt: Date.now() });
        count += 1;
      }
    }
    return count;
  }
}
```

If the `Keyed<T>` conditional type fights the compiler, replace it with the plain structural type shown in the test's `memoryKeyed()` return and cast `openKeyedStore` results to it — the store only uses `register`, `lookup`, `entries`, `delete`.

- [ ] **Step 4: Run tests** → PASS (3 tests).
- [ ] **Step 5: Commit** — `git add extensions/duties/src/store.ts extensions/duties/src/store.test.ts && git commit -m "feat(duties): duty and run store over the plugin keyed store"`

---

### Task 4: Credential adapter (OS keychain), values never on argv

**Files:**

- Create: `extensions/duties/src/creds.ts`, `extensions/duties/src/creds.test.ts`

**Interfaces:**

- Produces: `type ExecFn = (file: string, args: string[], opts?: { input?: string; env?: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>`; `credGet(key, platform?, exec?): Promise<string>`; `credSet(key, value, platform?, exec?): Promise<void>`; `credHas(key, platform?, exec?): Promise<boolean>`; `CRED_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u`. Service name prefix `openclaw-duties.`.

- [ ] **Step 1: Failing tests**

```ts
// extensions/duties/src/creds.test.ts
import { describe, expect, it, vi } from "vitest";
import { credGet, credHas, credSet } from "./creds.js";

describe("creds (macOS)", () => {
  it("reads through `security find-generic-password -w` with a namespaced service", async () => {
    const exec = vi.fn(async () => ({ stdout: "s3cret\n" }));
    await expect(credGet("amigos.password", "darwin", exec)).resolves.toBe("s3cret");
    expect(exec).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "openclaw-duties.amigos.password", "-w"],
      undefined,
    );
  });
  it("never puts the value on argv when saving; it goes via stdin", async () => {
    const exec = vi.fn(async () => ({ stdout: "" }));
    await credSet("amigos.password", "s3cret", "darwin", exec);
    const [file, args, opts] = exec.mock.calls[0]!;
    expect(file).toBe("security");
    expect(args.join(" ")).not.toContain("s3cret");
    expect(opts?.input).toContain("s3cret");
  });
  it("maps a missing item to a plain error without echoing security's stderr", async () => {
    const exec = vi.fn(async () => {
      throw new Error("security: SecKeychainSearchCopyNext: openclaw-duties.x");
    });
    await expect(credGet("x", "darwin", exec)).rejects.toThrow("no credential stored for x");
    await expect(credHas("x", "darwin", exec)).resolves.toBe(false);
  });
  it("rejects malformed keys", async () => {
    await expect(credGet("Bad Key!", "darwin", vi.fn())).rejects.toThrow("invalid credential key");
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
// extensions/duties/src/creds.ts
import { execFile } from "node:child_process";

export type ExecFn = (
  file: string,
  args: string[],
  opts?: { input?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;
export const CRED_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const SERVICE_PREFIX = "openclaw-duties.";

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env: opts?.env ?? process.env, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout) });
      },
    );
    if (opts?.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });

function assertKey(key: string): void {
  if (!CRED_KEY_RE.test(key)) throw new Error("invalid credential key");
}

export async function credGet(
  key: string,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFn = defaultExec,
): Promise<string> {
  assertKey(key);
  try {
    if (platform === "darwin") {
      const { stdout } = await exec(
        "security",
        ["find-generic-password", "-s", SERVICE_PREFIX + key, "-w"],
        undefined,
      );
      return stdout.replace(/\n$/u, "");
    }
    if (platform === "win32") {
      const { stdout } = await exec(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WIN_READ],
        { env: { ...process.env, OCD_TARGET: SERVICE_PREFIX + key } },
      );
      return stdout;
    }
  } catch {
    throw new Error(`no credential stored for ${key}`);
  }
  throw new Error(`credential store not supported on ${platform}`);
}

export async function credSet(
  key: string,
  value: string,
  platform: NodeJS.Platform = process.platform,
  exec: ExecFn = defaultExec,
): Promise<void> {
  assertKey(key);
  if (platform === "darwin") {
    // `security -i` reads commands from stdin, so the secret never appears in argv.
    const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    await exec("security", ["-i"], {
      input: `add-generic-password -U -s "${SERVICE_PREFIX}${key}" -a openclaw -w "${escaped}"\n`,
    });
    return;
  }
  if (platform === "win32") {
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_WRITE], {
      env: { ...process.env, OCD_TARGET: SERVICE_PREFIX + key, OCD_SECRET: value },
    });
    return;
  }
  throw new Error(`credential store not supported on ${platform}`);
}

export async function credHas(
  key: string,
  platform?: NodeJS.Platform,
  exec?: ExecFn,
): Promise<boolean> {
  try {
    await credGet(key, platform, exec);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("no credential stored")) return false;
    throw error;
  }
}

const WIN_CS = `
using System; using System.Runtime.InteropServices;
public static class OcdCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL c, uint f);
  [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string t, uint ty, uint f, out IntPtr p);
  [DllImport("advapi32")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string secret) {
    byte[] blob = System.Text.Encoding.Unicode.GetBytes(secret); IntPtr ptr = Marshal.AllocHGlobal(blob.Length); Marshal.Copy(blob, 0, ptr, blob.Length);
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.CredentialBlobSize = (uint)blob.Length; c.CredentialBlob = ptr; c.Persist = 2; c.UserName = "openclaw";
    bool ok = CredWriteW(ref c, 0); Marshal.FreeHGlobal(ptr); if (!ok) throw new Exception("CredWrite failed"); }
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) throw new Exception("not found");
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); if (c.CredentialBlobSize == 0) return "";
      byte[] b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, (int)c.CredentialBlobSize); return System.Text.Encoding.Unicode.GetString(b); }
    finally { CredFree(p); } } }`;
const WIN_READ = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WIN_CS}\n'@; [Console]::Out.Write([OcdCred]::Read($env:OCD_TARGET))`;
const WIN_WRITE = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WIN_CS}\n'@; [OcdCred]::Write($env:OCD_TARGET, $env:OCD_SECRET)`;
```

- [ ] **Step 4: Run → PASS (4 tests).** Then a one-off manual check on this Mac (not a test): `node -e` is not available for ESM in-repo; instead run `node --import ./scripts/tsx.mjs -e "import('./extensions/duties/src/creds.ts').then(async m=>{await m.credSet('duties-selftest','abc');console.log(await m.credGet('duties-selftest'))})"` → prints `abc`; then delete it with `security delete-generic-password -s openclaw-duties.duties-selftest`.
- [ ] **Step 5: Commit** — `git commit -am "feat(duties): OS keychain credential adapter"` (stage only the two files).

---

### Task 5: Runner core with injected adapters

**Files:**

- Create: `extensions/duties/src/runner.ts`, `extensions/duties/src/runner.test.ts`

**Interfaces:**

- Consumes: `Duty`, `DutyNode`, `Step`, `Cond`, `Target`, `Check`, `resolvePlaceholders` (Task 2); `StepEvidence`, `DutyRun` (Task 3).
- Produces:
  ```ts
  type BrowserAdapter = {
    open(url: string): Promise<{ targetId: string }>;
    navigate(targetId: string, url: string): Promise<void>;
    isVisible(targetId: string, target: Target): Promise<boolean>;
    click(targetId: string, target: Target): Promise<void>;
    fill(targetId: string, target: Target, value: string): Promise<void>;
    select(targetId: string, target: Target, value: string): Promise<void>;
    press(targetId: string, key: string): Promise<void>;
    waitFor(
      targetId: string,
      opts: { target?: Target; text?: string; url?: string; timeoutMs?: number },
    ): Promise<void>;
    text(targetId: string, target?: Target): Promise<string>;
    url(targetId: string): Promise<string>;
    evaluate(targetId: string, fn: string): Promise<unknown>;
    screenshot(targetId: string): Promise<string | undefined>; // blob id
    close(targetId: string): Promise<void>;
  };
  type AiAdapter = {
    extract(params: {
      instruction: string;
      input: unknown;
      schema: Record<string, unknown>;
    }): Promise<Record<string, unknown>>;
  };
  type AskAdapter = {
    ask(params: {
      stepId: string;
      question: string;
      header: string;
      options: string[];
      timeoutMs?: number;
    }): Promise<{ status: "answered"; answer: string } | { status: "timeout" | "cancelled" }>;
  };
  type RunnerDeps = {
    browser: BrowserAdapter;
    ai: AiAdapter;
    ask: AskAdapter;
    cred: (key: string) => Promise<string>;
    now?: () => number;
    onStep?: (evidence: StepEvidence) => void;
  };
  type RunOptions = {
    inputs: Record<string, unknown>;
    toStepId?: string;
    keepOpen?: boolean;
    targetId?: string;
  };
  type RunOutcome = {
    status: "ok" | "failed" | "blocked" | "cancelled";
    steps: StepEvidence[];
    outputs: Record<string, unknown>;
    failedStep?: string;
    report?: string;
    targetId?: string;
  };
  async function runDuty(duty: Duty, deps: RunnerDeps, options: RunOptions): Promise<RunOutcome>;
  ```
- Browser step `params.action` ∈ `open | navigate | click | fill | select | press | wait | read | screenshot`; `read` saves `text(target)` to `saveAs`; `browser.evaluate` uses `params.fn` and saves the result; `ai` params `{ instruction, input, schema }` and `saveAs` may be an array (spread object keys); `ask` params `{ question, header?, options?: string[] }`, `saveAs` gets the answer; `when` conds: `visible` → `browser.isVisible`, `equals` → both sides resolved then compared as strings, `text_matches` → regex over `browser.text(targetId)`.
- A `stop` node ends the run with `status: "ok"` and `report` = resolved reason. A failed check or thrown adapter error → `status: "failed"`, `failedStep`. An `ask` timeout/cancel → `status: "blocked"`. `toStepId` stops after that step with `status: "ok"` and returns `targetId` when `keepOpen`.

- [ ] **Step 1: Failing tests**

```ts
// extensions/duties/src/runner.test.ts
import { describe, expect, it, vi } from "vitest";
import type { Duty } from "./duty.js";
import { runDuty, type RunnerDeps } from "./runner.js";

function fakeDeps(over: Partial<RunnerDeps> = {}): RunnerDeps & { calls: string[] } {
  const calls: string[] = [];
  const browser: RunnerDeps["browser"] = {
    open: async (url) => {
      calls.push(`open ${url}`);
      return { targetId: "t1" };
    },
    navigate: async (_t, url) => {
      calls.push(`navigate ${url}`);
    },
    isVisible: async () => false,
    click: async (_t, target) => {
      calls.push(`click ${JSON.stringify(target)}`);
    },
    fill: async (_t, target, value) => {
      calls.push(`fill ${target.css} ${value}`);
    },
    select: async () => {},
    press: async () => {},
    waitFor: async () => {},
    text: async () => "Welcome Ask !",
    url: async () => "https://x/Home/Dashboard",
    evaluate: async () => 42,
    screenshot: async () => "blob-1",
    close: async () => {
      calls.push("close");
    },
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
  };
}

const duty = (steps: Duty["steps"]): Duty => ({
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

describe("runDuty", () => {
  it("runs browser, ai and ask steps, resolves placeholders and records evidence", async () => {
    const deps = fakeDeps();
    const outcome = await runDuty(
      duty([
        {
          id: "s1",
          kind: "browser",
          label: "Open Amigos",
          params: { action: "open", url: "https://amigosalliance.co.in" },
        },
        {
          id: "s2",
          kind: "ai",
          label: "Read the mail",
          params: { instruction: "extract", input: "{{in:mail}}", schema: { type: "object" } },
          saveAs: ["origin", "destination"],
        },
        {
          id: "s3",
          kind: "ask",
          label: "Which account?",
          params: {
            question: "Which corporate account for {{out:origin}}?",
            options: ["LIC Nagpur", "LIC Aurangabad"],
          },
          saveAs: "account",
        },
        {
          id: "s4",
          kind: "browser",
          label: "Fill username",
          params: { action: "fill", value: "{{cred:amigos.username}}" },
          target: { css: "#UserId" },
        },
        {
          id: "s5",
          kind: "browser",
          label: "Check dashboard",
          params: { action: "wait" },
          check: { url_matches: "/Home/Dashboard" },
        },
      ]),
      deps,
      { inputs: { mail: "hello" } },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.outputs).toEqual({ origin: "IXU", destination: "COK", account: "LIC Nagpur" });
    expect(deps.calls).toContain("fill #UserId cred(amigos.username)");
    expect(outcome.steps.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(outcome.steps[3]!.summary).not.toContain("cred(");
    expect(deps.calls.at(-1)).toBe("close");
  });
  it("skips a when-group whose probe is visible and stops with the resolved reason", async () => {
    const deps = fakeDeps({ browser: { isVisible: async () => true } as never });
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          kind: "when",
          label: "If signed out, sign in",
          cond: { visible: { text: "Welcome" } },
          then: [],
          else: [
            {
              id: "s2",
              kind: "browser",
              label: "Click login",
              params: { action: "click" },
              target: { role: "button", name: "Login" },
            },
          ],
        },
        { kind: "stop", label: "Nothing to book", reason: "No booking in {{in:mail}}" },
        {
          id: "s9",
          kind: "browser",
          label: "Never runs",
          params: { action: "click" },
          target: { css: "#x" },
        },
      ]),
      deps,
      { inputs: { mail: "mail-1" } },
    );
    expect(outcome.status).toBe("ok");
    expect(outcome.report).toBe("No booking in mail-1");
    expect(deps.calls.some((c) => c.startsWith("click"))).toBe(false);
    expect(outcome.steps.map((s) => s.stepId)).not.toContain("s9");
  });
  it("fails loudly on a failed check and names the step", async () => {
    const deps = fakeDeps({ browser: { url: async () => "https://x/login" } as never });
    const outcome = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Sign in landed",
          params: { action: "wait" },
          check: { url_matches: "/Home/Dashboard" },
        },
      ]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.failedStep).toBe("s2");
    expect(outcome.steps[1]!.status).toBe("failed");
  });
  it("blocks when an ask times out and stops early at toStepId keeping the tab", async () => {
    const blocked = await runDuty(
      duty([
        { id: "s1", kind: "ask", label: "OTP?", params: { question: "Code?" }, saveAs: "otp" },
      ]),
      fakeDeps({ ask: { ask: async () => ({ status: "timeout" }) } }),
      { inputs: {} },
    );
    expect(blocked.status).toBe("blocked");
    const deps = fakeDeps();
    const partial = await runDuty(
      duty([
        { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
        {
          id: "s2",
          kind: "browser",
          label: "Later",
          params: { action: "click" },
          target: { css: "#y" },
        },
      ]),
      deps,
      { inputs: {}, toStepId: "s1", keepOpen: true },
    );
    expect(partial.status).toBe("ok");
    expect(partial.targetId).toBe("t1");
    expect(deps.calls).not.toContain("close");
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `runner.ts`**

```ts
// extensions/duties/src/runner.ts
import {
  type Check,
  type Cond,
  type Duty,
  type DutyNode,
  type Step,
  type Target,
  resolvePlaceholders,
} from "./duty.js";
import type { StepEvidence } from "./store.js";

export type BrowserAdapter = {
  open(url: string): Promise<{ targetId: string }>;
  navigate(targetId: string, url: string): Promise<void>;
  isVisible(targetId: string, target: Target): Promise<boolean>;
  click(targetId: string, target: Target): Promise<void>;
  fill(targetId: string, target: Target, value: string): Promise<void>;
  select(targetId: string, target: Target, value: string): Promise<void>;
  press(targetId: string, key: string): Promise<void>;
  waitFor(
    targetId: string,
    opts: { target?: Target; text?: string; url?: string; timeoutMs?: number },
  ): Promise<void>;
  text(targetId: string, target?: Target): Promise<string>;
  url(targetId: string): Promise<string>;
  evaluate(targetId: string, fn: string): Promise<unknown>;
  screenshot(targetId: string): Promise<string | undefined>;
  close(targetId: string): Promise<void>;
};
export type AiAdapter = {
  extract(params: {
    instruction: string;
    input: unknown;
    schema: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
};
export type AskResult =
  { status: "answered"; answer: string } | { status: "timeout" | "cancelled" };
export type AskAdapter = {
  ask(params: {
    stepId: string;
    question: string;
    header: string;
    options: string[];
    timeoutMs?: number;
  }): Promise<AskResult>;
};
export type RunnerDeps = {
  browser: BrowserAdapter;
  ai: AiAdapter;
  ask: AskAdapter;
  cred: (key: string) => Promise<string>;
  now?: () => number;
  onStep?: (evidence: StepEvidence) => void;
};
export type RunOptions = {
  inputs: Record<string, unknown>;
  toStepId?: string;
  keepOpen?: boolean;
  targetId?: string;
};
export type RunOutcome = {
  status: "ok" | "failed" | "blocked" | "cancelled";
  steps: StepEvidence[];
  outputs: Record<string, unknown>;
  failedStep?: string;
  report?: string;
  targetId?: string;
};

class StopSignal {
  constructor(readonly reason: string) {}
}
class HaltSignal {
  constructor(
    readonly outcome: RunOutcome["status"],
    readonly stepId: string,
    readonly message: string,
  ) {}
}

const MASK = "••••••";

export async function runDuty(
  duty: Duty,
  deps: RunnerDeps,
  options: RunOptions,
): Promise<RunOutcome> {
  const now = deps.now ?? Date.now;
  const outputs: Record<string, unknown> = {};
  const evidence: StepEvidence[] = [];
  let targetId = options.targetId;
  let reachedStop = false;
  const ctx = () => ({ out: outputs, in: options.inputs, cred: deps.cred });
  const resolve = (value: unknown) =>
    typeof value === "string" ? resolvePlaceholders(value, ctx()) : Promise.resolve(value);
  const requireTab = (): string => {
    if (!targetId) throw new Error("no browser tab: add an open step first");
    return targetId;
  };

  const record = (partial: Omit<StepEvidence, "durationMs"> & { startedAt: number }) => {
    const { startedAt, ...rest } = partial;
    const item: StepEvidence = { ...rest, durationMs: now() - startedAt };
    evidence.push(item);
    deps.onStep?.(item);
  };

  const evalCond = async (cond: Cond): Promise<boolean> => {
    if ("visible" in cond) return deps.browser.isVisible(requireTab(), cond.visible);
    if ("equals" in cond)
      return (await resolve(cond.equals[0])) === (await resolve(cond.equals[1]));
    return new RegExp(cond.text_matches, "iu").test(await deps.browser.text(requireTab()));
  };

  const runCheck = async (check: Check): Promise<string | undefined> => {
    const tab = requireTab();
    if (check.visible && !(await deps.browser.isVisible(tab, check.visible)))
      return `expected ${describeTarget(check.visible)} to be visible`;
    if (check.url_matches && !new RegExp(check.url_matches, "iu").test(await deps.browser.url(tab)))
      return `url did not match ${check.url_matches}`;
    if (
      check.text_matches &&
      !new RegExp(check.text_matches, "iu").test(await deps.browser.text(tab))
    )
      return `page text did not match ${check.text_matches}`;
    if (check.non_empty && !String(outputs[check.non_empty] ?? "").trim())
      return `output ${check.non_empty} is empty`;
    return undefined;
  };

  const save = (step: Step, value: unknown) => {
    if (!step.saveAs) return;
    if (Array.isArray(step.saveAs)) {
      for (const key of step.saveAs)
        outputs[key] = (value as Record<string, unknown> | undefined)?.[key];
    } else outputs[step.saveAs] = value;
  };

  const runStep = async (step: Step): Promise<void> => {
    const startedAt = now();
    let summary = "";
    let usedCred = false;
    try {
      if (step.kind === "browser") {
        const action = String(step.params.action);
        if (action === "open") {
          const url = String(await resolve(step.params.url));
          targetId = (await deps.browser.open(url)).targetId;
          summary = url;
        } else if (action === "navigate") {
          const url = String(await resolve(step.params.url));
          await deps.browser.navigate(requireTab(), url);
          summary = url;
        } else if (action === "click") {
          await deps.browser.click(requireTab(), step.target!);
          summary = describeTarget(step.target!);
        } else if (action === "fill" || action === "select") {
          const raw = String(step.params.value ?? "");
          usedCred = /\{\{cred:/u.test(raw);
          const value = String(await resolve(raw));
          if (action === "fill") await deps.browser.fill(requireTab(), step.target!, value);
          else await deps.browser.select(requireTab(), step.target!, value);
          summary = `${describeTarget(step.target!)} ← ${usedCred ? MASK : value}`;
        } else if (action === "press") {
          await deps.browser.press(requireTab(), String(step.params.key));
          summary = String(step.params.key);
        } else if (action === "wait") {
          await deps.browser.waitFor(requireTab(), {
            target: step.target,
            text: step.params.text as string | undefined,
            url: step.params.url as string | undefined,
            timeoutMs: step.timeoutMs,
          });
          summary = "waited";
        } else if (action === "read") {
          const text = await deps.browser.text(requireTab(), step.target);
          save(step, text);
          summary = text.slice(0, 120);
        } else if (action === "screenshot") {
          summary = "screenshot";
        } else throw new Error(`unknown browser action "${action}"`);
      } else if (step.kind === "browser.evaluate") {
        const result = await deps.browser.evaluate(requireTab(), String(step.params.fn));
        save(step, result);
        summary = JSON.stringify(result)?.slice(0, 120) ?? "";
      } else if (step.kind === "ai") {
        const result = await deps.ai.extract({
          instruction: String(await resolve(step.params.instruction)),
          input: await resolve(step.params.input),
          schema: (step.params.schema as Record<string, unknown>) ?? { type: "object" },
        });
        save(step, result);
        summary = Object.keys(result).join(", ");
      } else if (step.kind === "ask") {
        const result = await deps.ask.ask({
          stepId: step.id,
          question: String(await resolve(step.params.question)),
          header: String(step.params.header ?? step.label).slice(0, 12),
          options: (step.params.options as string[] | undefined) ?? [],
          timeoutMs: step.timeoutMs,
        });
        if (result.status !== "answered")
          throw new HaltSignal(
            result.status === "cancelled" ? "cancelled" : "blocked",
            step.id,
            `no answer to "${step.label}"`,
          );
        save(step, result.answer);
        summary = result.answer;
      }
      if (step.check) {
        const problem = await runCheck(step.check);
        if (problem) throw new Error(problem);
      }
      record({
        stepId: step.id,
        label: step.label,
        kind: step.kind,
        status: "ok",
        summary,
        target: step.target ? describeTarget(step.target) : undefined,
        startedAt,
        screenshotBlobId:
          step.kind.startsWith("browser") && targetId
            ? await deps.browser.screenshot(targetId).catch(() => undefined)
            : undefined,
      });
    } catch (error) {
      const shot = targetId
        ? await deps.browser.screenshot(targetId).catch(() => undefined)
        : undefined;
      record({
        stepId: step.id,
        label: step.label,
        kind: step.kind,
        status: "failed",
        summary:
          error instanceof HaltSignal ? error.message : String((error as Error).message ?? error),
        startedAt,
        screenshotBlobId: shot,
      });
      throw error instanceof HaltSignal
        ? error
        : new HaltSignal("failed", step.id, String((error as Error).message ?? error));
    }
    if (options.toStepId === step.id) throw new StopSignal("");
  };

  const walk = async (nodes: DutyNode[]): Promise<void> => {
    for (const node of nodes) {
      if (node.kind === "when") {
        await walk((await evalCond(node.cond)) ? node.then : (node.else ?? []));
        continue;
      }
      if (node.kind === "stop") {
        reachedStop = true;
        throw new StopSignal(String(await resolve(node.reason)));
      }
      await runStep(node);
    }
  };

  let status: RunOutcome["status"] = "ok";
  let failedStep: string | undefined;
  let report: string | undefined;
  try {
    await walk(duty.steps);
  } catch (signal) {
    if (signal instanceof StopSignal) {
      report = reachedStop ? signal.reason : undefined;
    } else if (signal instanceof HaltSignal) {
      status = signal.outcome;
      failedStep = signal.stepId;
      report = signal.message;
    } else {
      status = "failed";
      report = String((signal as Error).message ?? signal);
    }
  }
  if (targetId && !options.keepOpen) {
    await deps.browser.close(targetId).catch(() => {});
  }
  return {
    status,
    steps: evidence,
    outputs,
    failedStep,
    report,
    targetId: options.keepOpen ? targetId : undefined,
  };
}

export function describeTarget(target: Target): string {
  if (target.role || target.name)
    return `${target.role ?? ""}${target.name ? ` "${target.name}"` : ""}`.trim();
  if (target.text) return `text "${target.text}"`;
  return target.css ?? "?";
}
```

- [ ] **Step 4: Run → PASS (4 tests).**
- [ ] **Step 5: Commit** — `git add extensions/duties/src/runner.ts extensions/duties/src/runner.test.ts && git commit -m "feat(duties): deterministic runner with injected adapters"`

---

### Task 6: Browser adapter over `browser.request`

**Files:**

- Create: `extensions/duties/src/adapters/browser.ts`, `extensions/duties/src/adapters/browser.test.ts`

**Interfaces:**

- Consumes: `BrowserAdapter`, `Target` (Task 5/2). Gateway method `browser.request` params `{ method: "GET"|"POST"|"DELETE", path, query?, body?, timeoutMs? }` (verified in `extensions/browser/src/gateway/browser-request.ts`), called with `api.runtime.gateway.request(method, params, { scopes: ["operator.admin"] })`. Routes (verified): `POST /tabs/open {url,label}`, `POST /navigate {url,targetId}`, `GET /snapshot?targetId&interactive=true&refs=role&profile`, `POST /act {kind, ref|selector, targetId, text?, value?, key?, fn?, ...}`, `GET /text?targetId`, `POST /screenshot {targetId}` (check the exact body in `extensions/browser/src/browser/client.ts` → `browserScreenshot` before implementing), `DELETE /tabs/<id>`.
- Produces: `createBrowserAdapter(params: { request: <T>(method: string, params: Record<string, unknown>) => Promise<T>; profile: string; blobs?: { put(bytes: Uint8Array, contentType: string): Promise<string> } }): BrowserAdapter` and `resolveRef(snapshotText: string, target: Target): string | undefined` — parses role-snapshot lines like `- button "Sign-in" [ref=e37]` and returns the ref for the first line whose role matches `target.role` (if given) and whose quoted name equals `target.name` (case-insensitive) or contains `target.text`; returns `undefined` when zero or more than one line matches.

- [ ] **Step 1: Failing tests**

```ts
// extensions/duties/src/adapters/browser.test.ts
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
    expect(bodies.find((p) => (p.body as { kind?: string })?.kind === "fill")?.body).toMatchObject({
      kind: "fill",
      fields: [{ selector: "#UserId", value: "ask" }],
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
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
// extensions/duties/src/adapters/browser.ts
import type { Target } from "../duty.js";
import { describeTarget, type BrowserAdapter } from "../runner.js";

type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
const LINE_RE = /^\s*-\s*([a-z]+)\s*(?:"((?:[^"\\]|\\.)*)")?.*?\[ref=([a-z0-9]+)\]/iu;

export function resolveRef(snapshot: string, target: Target): string | undefined {
  const matches: string[] = [];
  for (const line of snapshot.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, role, name = "", ref] = m;
    if (target.role && role.toLowerCase() !== target.role.toLowerCase()) continue;
    if (target.name && name.toLowerCase() !== target.name.toLowerCase()) continue;
    if (target.text && !name.toLowerCase().includes(target.text.toLowerCase())) continue;
    if (!target.role && !target.name && !target.text) continue;
    matches.push(ref);
  }
  return matches.length === 1 ? matches[0] : undefined;
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
  const snapshot = async (targetId: string) => {
    const result = await call<{ snapshot?: string; text?: string }>("GET", "/snapshot", {
      query: { targetId, interactive: "true", refs: "role" },
    });
    return result.snapshot ?? result.text ?? "";
  };
  const locate = async (
    targetId: string,
    target: Target,
  ): Promise<{ ref?: string; selector?: string }> => {
    if (target.css && !target.role && !target.name && !target.text) return { selector: target.css };
    const snap = await snapshot(targetId);
    const ref = resolveRef(snap, target);
    if (ref) return { ref };
    if (target.css) return { selector: target.css };
    const count = snap
      .split("\n")
      .filter(
        (l) =>
          LINE_RE.test(l) &&
          (!target.role || l.toLowerCase().includes(`- ${target.role.toLowerCase()}`)) &&
          (target.name ? l.toLowerCase().includes(`"${target.name.toLowerCase()}"`) : true),
      ).length;
    throw new Error(
      count > 1
        ? `${describeTarget(target)}: ${count} matches (ambiguous)`
        : `${describeTarget(target)}: not found on the page`,
    );
  };
  const act = (targetId: string, body: Record<string, unknown>, timeoutMs?: number) =>
    call("POST", "/act", { body: { ...body, targetId }, timeoutMs });
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
      await act(targetId, { kind: "fill", fields: [{ ...loc, value }] });
    },
    async select(targetId, target, value) {
      await act(targetId, { kind: "select", ...(await locate(targetId, target)), values: [value] });
    },
    async press(targetId, key) {
      await act(targetId, { kind: "press", key });
    },
    async waitFor(targetId, opts) {
      const body: Record<string, unknown> = { kind: "wait", timeoutMs: opts.timeoutMs ?? 15_000 };
      if (opts.text) body.text = opts.text;
      if (opts.url) body.url = opts.url;
      if (opts.target?.css) body.selector = opts.target.css;
      await act(targetId, body, (opts.timeoutMs ?? 15_000) + 5_000);
      if (opts.target && !opts.target.css) await locate(targetId, opts.target);
    },
    async text(targetId, target) {
      const r = await call<{ text?: string }>("GET", "/text", {
        query: { targetId, ...(target?.css ? { selector: target.css } : {}) },
      });
      return r.text ?? "";
    },
    async url(targetId) {
      const tabs = await call<
        | Array<{ targetId: string; url: string }>
        | { tabs: Array<{ targetId: string; url: string }> }
      >("GET", "/tabs");
      const list = Array.isArray(tabs) ? tabs : tabs.tabs;
      return list.find((t) => t.targetId === targetId)?.url ?? "";
    },
    async evaluate(targetId, fn) {
      const r = (await act(targetId, { kind: "evaluate", fn })) as { result?: unknown };
      return r?.result ?? r;
    },
    async screenshot(targetId) {
      if (!params.blobs) return undefined;
      const r = await call<{ base64?: string; data?: string }>("POST", "/screenshot", {
        body: { targetId, fullPage: false },
      });
      const b64 = r.base64 ?? r.data;
      if (!b64) return undefined;
      return params.blobs.put(Uint8Array.from(Buffer.from(b64, "base64")), "image/jpeg");
    },
    async close(targetId) {
      await call("DELETE", `/tabs/${encodeURIComponent(targetId)}`);
    },
  };
}
```

Before running the tests, confirm the exact response fields of `/snapshot`, `/text`, `/tabs`, and `/screenshot` in `extensions/browser/src/browser/client.ts` (functions `browserSnapshot`, `browserTabs`, `browserScreenshot`) and adjust the field names above (`snapshot`/`text`, `tabs`, `base64`) to what the route returns. Record what you found in the commit message.

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git add extensions/duties/src/adapters/browser.ts extensions/duties/src/adapters/browser.test.ts && git commit -m "feat(duties): browser adapter over browser.request with durable target resolution"`

---

### Task 7: AI and ask adapters over `tools.invoke` and `question.*`

**Files:**

- Create: `extensions/duties/src/adapters/ai.ts`, `extensions/duties/src/adapters/ask.ts`, `extensions/duties/src/adapters/ai-ask.test.ts`

**Interfaces:**

- Consumes: `AiAdapter`, `AskAdapter` (Task 5). Gateway `tools.invoke` params `{ name, args, sessionKey?, agentId? }` (verified `packages/gateway-protocol/src/schema/agents-models-skills.ts:1332`); `question.request` params `{ questions: [{ questionId, header (≤12 chars), question, options: [{label}], multiSelect? }], sessionKey?, timeoutMs? }` → `{ id, expiresAtMs }`; `question.waitAnswer { id, timeoutMs }` → `{ status: "pending" | "answered" | "cancelled" | "expired", answers?: { answers: Record<questionId, string[]> } }` (verified `packages/gateway-protocol/src/schema/questions.ts`).
- Produces: `createAiAdapter({ request, sessionKey }): AiAdapter` calling `tools.invoke` with `name: "llm-task"`, `args: { prompt: instruction, input, schema }` and returning the parsed JSON object; `createAskAdapter({ request, sessionKey, pollMs? }): AskAdapter` that requests the question and polls `question.waitAnswer` (each call with `timeoutMs: 60_000`) until answered/expired/cancelled or the step timeout (default 15 min) elapses.

- [ ] **Step 1: Failing tests**

```ts
// extensions/duties/src/adapters/ai-ask.test.ts
import { describe, expect, it, vi } from "vitest";
import { createAiAdapter } from "./ai.js";
import { createAskAdapter } from "./ask.js";

describe("ai adapter", () => {
  it("invokes llm-task and returns its JSON object", async () => {
    const request = vi.fn(async () => ({
      result: { content: [{ type: "text", text: JSON.stringify({ origin: "IXU" }) }] },
    }));
    const ai = createAiAdapter({ request, sessionKey: "main" });
    await expect(
      ai.extract({ instruction: "x", input: "mail", schema: { type: "object" } }),
    ).resolves.toEqual({ origin: "IXU" });
    expect(request).toHaveBeenCalledWith(
      "tools.invoke",
      expect.objectContaining({
        name: "llm-task",
        sessionKey: "main",
        args: expect.objectContaining({ prompt: "x", input: "mail" }),
      }),
    );
  });
});

describe("ask adapter", () => {
  it("requests a question and returns the first answer", async () => {
    let polls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "question.request") return { id: "q1", expiresAtMs: 1 };
      polls += 1;
      return polls < 2
        ? { status: "pending" }
        : { status: "answered", answers: { answers: { account: ["LIC Nagpur"] } } };
    });
    const ask = createAskAdapter({ request, sessionKey: "main", pollMs: 1 });
    await expect(
      ask.ask({
        stepId: "account",
        question: "Which?",
        header: "Account",
        options: ["LIC Nagpur", "LIC Aurangabad"],
      }),
    ).resolves.toEqual({ status: "answered", answer: "LIC Nagpur" });
    expect(request).toHaveBeenCalledWith(
      "question.request",
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            questionId: "account",
            options: [{ label: "LIC Nagpur" }, { label: "LIC Aurangabad" }],
          }),
        ],
      }),
    );
  });
  it("returns timeout when the question expires", async () => {
    const request = vi.fn(async (method: string) =>
      method === "question.request" ? { id: "q1", expiresAtMs: 1 } : { status: "expired" },
    );
    const ask = createAskAdapter({ request, sessionKey: "main", pollMs: 1 });
    await expect(
      ask.ask({ stepId: "otp", question: "Code?", header: "OTP", options: [] }),
    ).resolves.toEqual({ status: "timeout" });
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

````ts
// extensions/duties/src/adapters/ai.ts
import type { AiAdapter } from "../runner.js";
type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

export function createAiAdapter(params: { request: Request; sessionKey: string }): AiAdapter {
  return {
    async extract({ instruction, input, schema }) {
      const result = await params.request<{ result?: unknown }>("tools.invoke", {
        name: "llm-task",
        sessionKey: params.sessionKey,
        args: { prompt: instruction, input, schema },
      });
      return parseToolJson(result.result);
    },
  };
}

export function parseToolJson(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    if (Array.isArray(content)) {
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      return parseToolJson(text);
    }
    const inner =
      (result as { output?: unknown; json?: unknown }).json ??
      (result as { output?: unknown }).output;
    if (inner !== undefined) return parseToolJson(inner);
    return result as Record<string, unknown>;
  }
  if (typeof result === "string") {
    const trimmed = result.trim().replace(/^```(?:json)?\s*|\s*```$/gu, "");
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  }
  throw new Error("ai step returned no JSON object");
}
````

```ts
// extensions/duties/src/adapters/ask.ts
import type { AskAdapter } from "../runner.js";
type Request = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function createAskAdapter(params: {
  request: Request;
  sessionKey: string;
  pollMs?: number;
}): AskAdapter {
  return {
    async ask({ stepId, question, header, options, timeoutMs }) {
      const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const requested = await params.request<{ id: string }>("question.request", {
        sessionKey: params.sessionKey,
        timeoutMs: budget,
        questions: [
          {
            questionId: stepId,
            header: header.slice(0, 12) || "Duty",
            question,
            options: options.map((label) => ({ label })),
          },
        ],
      });
      const deadline = Date.now() + budget;
      while (Date.now() < deadline) {
        const state = await params.request<{
          status: string;
          answers?: { answers: Record<string, string[]> };
        }>("question.waitAnswer", {
          id: requested.id,
          timeoutMs: Math.min(60_000, Math.max(1, deadline - Date.now())),
        });
        if (state.status === "answered")
          return { status: "answered", answer: state.answers?.answers[stepId]?.[0] ?? "" };
        if (state.status === "cancelled") return { status: "cancelled" };
        if (state.status === "expired") return { status: "timeout" };
        await new Promise((r) => setTimeout(r, params.pollMs ?? 500));
      }
      return { status: "timeout" };
    },
  };
}
```

Check `llm-task`'s real argument names in `extensions/llm-task/` (the tool schema: is it `prompt`/`input`/`schema`?) and adjust `args` and the test to match before running.

- [ ] **Step 4: Run → PASS (3 tests).**
- [ ] **Step 5: Commit** — `git commit -m "feat(duties): ai adapter via llm-task and ask adapter via gateway questions"` (stage the three files).

---

### Task 8: RunManager — run records, concurrency locks, live events

**Files:**

- Create: `extensions/duties/src/run-service.ts`, `extensions/duties/src/run-service.test.ts`

**Interfaces:**

- Consumes: `DutyStore`, `DutyRun` (Task 3); `runDuty`, `RunnerDeps` (Task 5).
- Produces:
  ```ts
  type RunEvent = {
    type: "run";
    runId: string;
    dutyId: string;
    status: RunStatus;
    step?: StepEvidence;
  };
  class RunManager {
    constructor(params: {
      store: DutyStore;
      deps: () => RunnerDeps;
      emit: (event: RunEvent) => void;
      maxParallel?: number;
    });
    start(params: {
      duty: Duty;
      inputs: Record<string, unknown>;
      trigger: string;
      toStepId?: string;
      keepOpen?: boolean;
      targetId?: string;
    }): Promise<{ runId: string; queued: boolean; reason?: string }>;
    wait(runId: string): Promise<DutyRun>; // resolves when the run reaches a terminal status
    cancel(runId: string): Promise<boolean>;
    async recoverOrphans(): Promise<number>; // store.markRunningRunsLost() at startup
  }
  ```
- Rules: an `exclusive` Duty never runs concurrently with itself (second `start` returns `queued: true, reason: "runs alone"` and starts when the first finishes); non-exclusive Duties run in parallel up to `maxParallel` (default 4). Each run keeps its own `targetId`. Every status change and every step evidence emits a `RunEvent`. `duty.lastRunAt` is set only when a run ends `ok`.

- [ ] **Step 1: Failing tests**

```ts
// extensions/duties/src/run-service.test.ts
import { describe, expect, it, vi } from "vitest";
import type { Duty } from "./duty.js";
import { RunManager } from "./run-service.js";
import { DutyStore } from "./store.js";
import type { RunnerDeps } from "./runner.js";

function memoryKeyed<T>() {
  const m = new Map<string, T>();
  return {
    register: async (k: string, v: T) => {
      m.set(k, v);
    },
    lookup: async (k: string) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value })),
    delete: async (k: string) => m.delete(k),
  };
}
const duty = (id: string, exclusive = false): Duty => ({
  id,
  name: id,
  summary: "",
  status: "active",
  machine: "gateway",
  reportsTo: "owner",
  exclusive,
  inputs: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
  steps: [
    { id: "s1", kind: "browser", label: "Open", params: { action: "open", url: "https://x" } },
  ],
});
function deps(delayMs: number): RunnerDeps {
  return {
    browser: {
      open: async () => {
        await new Promise((r) => setTimeout(r, delayMs));
        return { targetId: "t" };
      },
      navigate: async () => {},
      isVisible: async () => true,
      click: async () => {},
      fill: async () => {},
      select: async () => {},
      press: async () => {},
      waitFor: async () => {},
      text: async () => "",
      url: async () => "",
      evaluate: async () => null,
      screenshot: async () => undefined,
      close: async () => {},
    },
    ai: { extract: async () => ({}) },
    ask: { ask: async () => ({ status: "answered", answer: "" }) },
    cred: async () => "",
  };
}

describe("RunManager", () => {
  it("runs two different duties in parallel and records ok runs", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const emit = vi.fn();
    const mgr = new RunManager({ store, deps: () => deps(30), emit });
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      mgr.start({ duty: duty("a"), inputs: {}, trigger: "manual" }),
      mgr.start({ duty: duty("b"), inputs: {}, trigger: "manual" }),
    ]);
    const [ra, rb] = await Promise.all([mgr.wait(a.runId), mgr.wait(b.runId)]);
    expect([ra.status, rb.status]).toEqual(["ok", "ok"]);
    expect(Date.now() - t0).toBeLessThan(55);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run", runId: a.runId, status: "ok" }),
    );
  });
  it("queues a second run of an exclusive duty until the first finishes", async () => {
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const mgr = new RunManager({ store, deps: () => deps(30), emit: () => {} });
    const first = await mgr.start({ duty: duty("x", true), inputs: {}, trigger: "manual" });
    const second = await mgr.start({ duty: duty("x", true), inputs: {}, trigger: "manual" });
    expect(second.queued).toBe(true);
    expect((await store.getRun(second.runId))?.status).toBe("queued");
    await mgr.wait(second.runId);
    const r1 = await store.getRun(first.runId);
    const r2 = await store.getRun(second.runId);
    expect(r2!.startedAt).toBeGreaterThanOrEqual(r1!.endedAt!);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**

```ts
// extensions/duties/src/run-service.ts
import { randomUUID } from "node:crypto";
import type { Duty } from "./duty.js";
import { runDuty, type RunnerDeps } from "./runner.js";
import type { DutyRun, DutyStore, RunStatus, StepEvidence } from "./store.js";

export type RunEvent = {
  type: "run";
  runId: string;
  dutyId: string;
  status: RunStatus;
  step?: StepEvidence;
};
type Pending = {
  run: DutyRun;
  duty: Duty;
  toStepId?: string;
  keepOpen?: boolean;
  targetId?: string;
};

export class RunManager {
  private readonly active = new Map<string, Promise<DutyRun>>();
  private readonly waiters = new Map<string, { resolve: (run: DutyRun) => void }>();
  private readonly queue: Pending[] = [];
  private readonly activeByDuty = new Map<string, number>();
  private readonly cancelled = new Set<string>();
  private readonly maxParallel: number;
  constructor(
    private readonly params: {
      store: DutyStore;
      deps: () => RunnerDeps;
      emit: (event: RunEvent) => void;
      maxParallel?: number;
    },
  ) {
    this.maxParallel = params.maxParallel ?? 4;
  }

  async recoverOrphans(): Promise<number> {
    return this.params.store.markRunningRunsLost();
  }

  async start(p: {
    duty: Duty;
    inputs: Record<string, unknown>;
    trigger: string;
    toStepId?: string;
    keepOpen?: boolean;
    targetId?: string;
  }): Promise<{ runId: string; queued: boolean; reason?: string }> {
    const run: DutyRun = {
      id: randomUUID(),
      dutyId: p.duty.id,
      status: "queued",
      startedAt: Date.now(),
      trigger: p.trigger,
      inputs: p.inputs,
      outputs: {},
      steps: [],
    };
    await this.params.store.createRun(run);
    this.queue.push({
      run,
      duty: p.duty,
      toStepId: p.toStepId,
      keepOpen: p.keepOpen,
      targetId: p.targetId,
    });
    const queued = !this.canStart(p.duty);
    this.pump();
    return {
      runId: run.id,
      queued,
      reason: queued
        ? p.duty.exclusive
          ? "runs alone — waiting for the current run"
          : "waiting for a free slot"
        : undefined,
    };
  }

  wait(runId: string): Promise<DutyRun> {
    const active = this.active.get(runId);
    if (active) return active;
    return new Promise((resolve) => {
      this.waiters.set(runId, { resolve });
      this.params.store.getRun(runId).then((r) => {
        if (r && !["queued", "running", "needs_input"].includes(r.status)) {
          this.waiters.delete(runId);
          resolve(r);
        }
      });
    });
  }

  async cancel(runId: string): Promise<boolean> {
    const index = this.queue.findIndex((q) => q.run.id === runId);
    if (index >= 0) {
      const [item] = this.queue.splice(index, 1);
      await this.finish(item!.run, { status: "cancelled" });
      return true;
    }
    if (this.active.has(runId)) {
      this.cancelled.add(runId);
      return true;
    }
    return false;
  }

  private canStart(duty: Duty): boolean {
    if (this.active.size >= this.maxParallel) return false;
    return !(duty.exclusive && (this.activeByDuty.get(duty.id) ?? 0) > 0);
  }

  private pump(): void {
    for (let i = 0; i < this.queue.length; i += 1) {
      const item = this.queue[i]!;
      if (!this.canStart(item.duty)) continue;
      this.queue.splice(i, 1);
      i -= 1;
      this.launch(item);
    }
  }

  private launch(item: Pending): void {
    const { run, duty } = item;
    this.activeByDuty.set(duty.id, (this.activeByDuty.get(duty.id) ?? 0) + 1);
    const promise = (async () => {
      const started =
        (await this.params.store.updateRun(run.id, { status: "running", startedAt: Date.now() })) ??
        run;
      this.params.emit({ type: "run", runId: run.id, dutyId: duty.id, status: "running" });
      const deps = this.params.deps();
      const outcome = await runDuty(
        duty,
        {
          ...deps,
          onStep: (step) => {
            void this.params.store
              .updateRun(run.id, { steps: [...(started.steps ?? []), step] })
              .then((r) => {
                if (r) started.steps = r.steps;
              });
            this.params.emit({
              type: "run",
              runId: run.id,
              dutyId: duty.id,
              status: "running",
              step,
            });
          },
        },
        {
          inputs: run.inputs,
          toStepId: item.toStepId,
          keepOpen: item.keepOpen,
          targetId: item.targetId,
        },
      );
      const status: RunStatus = this.cancelled.has(run.id) ? "cancelled" : outcome.status;
      const final = await this.finish(run, {
        status,
        outputs: outcome.outputs,
        steps: outcome.steps,
        failedStep: outcome.failedStep,
        report: outcome.report,
      });
      if (status === "ok") {
        await this.params.store.saveDuty({ ...duty, lastRunAt: Date.now() });
      }
      return final;
    })().finally(() => {
      this.active.delete(run.id);
      this.cancelled.delete(run.id);
      this.activeByDuty.set(duty.id, Math.max(0, (this.activeByDuty.get(duty.id) ?? 1) - 1));
      this.pump();
    });
    this.active.set(run.id, promise);
  }

  private async finish(run: DutyRun, patch: Partial<DutyRun>): Promise<DutyRun> {
    const final = (await this.params.store.updateRun(run.id, {
      ...patch,
      endedAt: Date.now(),
    })) ?? { ...run, ...patch };
    this.params.emit({ type: "run", runId: run.id, dutyId: run.dutyId, status: final.status });
    this.waiters.get(run.id)?.resolve(final);
    this.waiters.delete(run.id);
    return final;
  }
}
```

- [ ] **Step 4: Run → PASS (2 tests).**
- [ ] **Step 5: Commit** — `git commit -m "feat(duties): run manager with concurrency locks and live events"` (stage the two files).

---

### Task 9: Wire the plugin — store, service, events, Gateway methods

**Files:**

- Modify: `extensions/duties/index.ts`
- Create: `extensions/duties/src/gateway-methods.ts`, `extensions/duties/src/gateway-methods.test.ts`, `extensions/duties/src/events.ts`

**Interfaces:**

- Consumes: `DutyStore`, `RunManager`, adapters (Tasks 3, 6, 7, 8); `api.registerGatewayMethod(method, handler, { scope })`, `api.registerService({ id, start(ctx), stop() })` with `ctx.gatewayEvents.emit(name, payload, { scope })` (Workboard `src/change-events.ts:15-25`); `api.runtime.gateway.request(method, params, { scopes })`.
- Produces Gateway methods (all respond `{ ok, ... }` via `context.respond(true, result)`):
  - `duties.list` (operator.read) → `{ duties: Duty[] }`
  - `duties.get { id }` (read) → `{ duty, runs: DutyRun[] (successful only, ≤20) }`
  - `duties.save { duty }` (operator.write) → `{ duty }`; validates with `validateDuty`, sets `updatedAt`
  - `duties.delete { id }` (operator.admin) → `{ ok: true }`
  - `duties.run { id, inputs?, toStepId?, keepOpen?, targetId? }` (write) → `{ runId, queued, reason? }`
  - `duties.run.get { runId }` (read) → `{ run }`
  - `duties.run.cancel { runId }` (write) → `{ ok }`
  - `duties.status { id, status }` (write) → `{ duty }` (active|paused only)
- Events: `plugin.duties.changed` `{ dutyId }` on save/delete/status, `plugin.duties.run` (the `RunEvent`), both `scope: "operator.read"`.
- `events.ts` exports `createDutiesEventService(): OpenClawPluginService & { emit(name: "changed" | "run", payload) }` following Workboard's change-events service exactly (holds `ctx.gatewayEvents` after `start`).

- [ ] **Step 1: Failing test for the methods (fake api)**

```ts
// extensions/duties/src/gateway-methods.test.ts
import { describe, expect, it, vi } from "vitest";
import { registerDutiesGatewayMethods } from "./gateway-methods.js";
import { DutyStore } from "./store.js";

function memoryKeyed<T>() {
  const m = new Map<string, T>();
  return {
    register: async (k: string, v: T) => {
      m.set(k, v);
    },
    lookup: async (k: string) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value })),
    delete: async (k: string) => m.delete(k),
  };
}

describe("duties gateway methods", () => {
  it("saves a valid duty, lists it, and rejects an invalid one", async () => {
    const methods = new Map<
      string,
      {
        handler: (ctx: {
          params: Record<string, unknown>;
          respond: (ok: boolean, result?: unknown, error?: unknown) => void;
        }) => Promise<void>;
        scope: string;
      }
    >();
    const api = {
      registerGatewayMethod: (name: string, handler: never, opts: { scope: string }) =>
        methods.set(name, { handler, scope: opts.scope }),
    } as never;
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    const emit = vi.fn();
    registerDutiesGatewayMethods({
      api,
      store,
      runs: { start: vi.fn(), cancel: vi.fn() } as never,
      emit,
    });
    expect(methods.get("duties.delete")?.scope).toBe("operator.admin");
    const call = async (name: string, params: Record<string, unknown>) =>
      new Promise<{ ok: boolean; result?: unknown; error?: unknown }>((resolve) =>
        methods
          .get(name)!
          .handler({ params, respond: (ok, result, error) => resolve({ ok, result, error }) }),
      );
    const duty = {
      id: "d1",
      name: "D",
      summary: "",
      status: "building",
      machine: "gateway",
      reportsTo: "owner",
      inputs: [],
      steps: [],
      triggers: [{ kind: "manual" }],
      updatedAt: 0,
    };
    expect((await call("duties.save", { duty })).ok).toBe(true);
    expect(emit).toHaveBeenCalledWith("changed", { dutyId: "d1" });
    expect(((await call("duties.list", {})).result as { duties: unknown[] }).duties).toHaveLength(
      1,
    );
    const bad = await call("duties.save", { duty: { ...duty, status: "draft" } });
    expect(bad.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `events.ts`, `gateway-methods.ts`, and wire `index.ts`**

```ts
// extensions/duties/src/events.ts
import type { OpenClawPluginService } from "../api.js";
type Emitter = { emit: (name: string, payload: unknown, opts: { scope: "operator.read" }) => void };
export function createDutiesEventService(): OpenClawPluginService & {
  emit(name: "changed" | "run", payload: Record<string, unknown>): void;
} {
  let events: Emitter | undefined;
  return {
    id: "duties:events",
    start(ctx) {
      events = (ctx as { gatewayEvents?: Emitter }).gatewayEvents;
    },
    stop() {
      events = undefined;
    },
    emit(name, payload) {
      events?.emit(name, payload, { scope: "operator.read" });
    },
  };
}
```

```ts
// extensions/duties/src/gateway-methods.ts
import type { OpenClawPluginApi } from "../api.js";
import { DUTY_STATUSES, validateDuty, type DutyStatus } from "./duty.js";
import type { RunManager } from "./run-service.js";
import type { DutyStore } from "./store.js";

type Ctx = Parameters<Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>[0];
type Scope = "operator.read" | "operator.write" | "operator.admin";

export function registerDutiesGatewayMethods(params: {
  api: OpenClawPluginApi;
  store: DutyStore;
  runs: Pick<RunManager, "start" | "cancel">;
  emit: (name: "changed" | "run", payload: Record<string, unknown>) => void;
}) {
  const { api, store, runs, emit } = params;
  const register = (
    method: string,
    scope: Scope,
    handler: (p: Record<string, unknown>) => Promise<unknown>,
  ) =>
    api.registerGatewayMethod(
      method,
      async (ctx: Ctx) => {
        try {
          ctx.respond(true, await handler((ctx.params ?? {}) as Record<string, unknown>));
        } catch (error) {
          ctx.respond(false, undefined, {
            code: "duties_error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope },
    );
  const id = (p: Record<string, unknown>) => {
    if (typeof p.id !== "string" || !p.id) throw new Error("id is required");
    return p.id;
  };
  const requireDuty = async (dutyId: string) => {
    const d = await store.getDuty(dutyId);
    if (!d) throw new Error(`no Duty "${dutyId}"`);
    return d;
  };

  register("duties.list", "operator.read", async () => ({ duties: await store.listDuties() }));
  register("duties.get", "operator.read", async (p) => {
    const duty = await requireDuty(id(p));
    return { duty, runs: await store.listRuns(duty.id, { onlySuccessful: true, limit: 20 }) };
  });
  register("duties.save", "operator.write", async (p) => {
    const result = validateDuty({ ...(p.duty as object), updatedAt: Date.now() });
    if (!result.ok) throw new Error(`invalid duty: ${result.errors.join("; ")}`);
    await store.saveDuty(result.duty);
    emit("changed", { dutyId: result.duty.id });
    return { duty: result.duty };
  });
  register("duties.delete", "operator.admin", async (p) => {
    const dutyId = id(p);
    await store.deleteDuty(dutyId);
    emit("changed", { dutyId });
    return { ok: true };
  });
  register("duties.status", "operator.write", async (p) => {
    const duty = await requireDuty(id(p));
    const status = p.status as DutyStatus;
    if (!DUTY_STATUSES.includes(status) || status === "building")
      throw new Error("status must be active or paused");
    const next = { ...duty, status, updatedAt: Date.now() };
    await store.saveDuty(next);
    emit("changed", { dutyId: duty.id });
    return { duty: next };
  });
  register("duties.run", "operator.write", async (p) => {
    const duty = await requireDuty(id(p));
    return runs.start({
      duty,
      inputs: (p.inputs as Record<string, unknown>) ?? {},
      trigger: "manual",
      toStepId: p.toStepId as string | undefined,
      keepOpen: p.keepOpen === true,
      targetId: p.targetId as string | undefined,
    });
  });
  register("duties.run.get", "operator.read", async (p) => {
    const run = await store.getRun(String(p.runId));
    if (!run) throw new Error("no such run");
    return { run };
  });
  register("duties.run.cancel", "operator.write", async (p) => ({
    ok: await runs.cancel(String(p.runId)),
  }));
}
```

```ts
// extensions/duties/index.ts (replace)
import { definePluginEntry } from "./api.js";
import { createAiAdapter } from "./src/adapters/ai.js";
import { createAskAdapter } from "./src/adapters/ask.js";
import { createBrowserAdapter } from "./src/adapters/browser.js";
import { credGet } from "./src/creds.js";
import { createDutiesEventService } from "./src/events.js";
import { registerDutiesGatewayMethods } from "./src/gateway-methods.js";
import { RunManager } from "./src/run-service.js";
import { DutyStore } from "./src/store.js";

export default definePluginEntry({
  id: "duties",
  name: "Duties",
  description: "Saved, replayable automations the agent authors from your instructions.",
  register(api) {
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "duties",
      label: "Duties",
      icon: "listChecks",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    const store = DutyStore.open(api);
    const events = createDutiesEventService();
    api.registerService(events);
    const request = <T = unknown>(method: string, params: Record<string, unknown>) =>
      api.runtime.gateway.request<T>(method, params, { scopes: ["operator.admin"] });
    const blobs = api.runtime.state.openBlobStore<{ kind: string }>({
      namespace: "evidence",
      maxEntries: 20_000,
      maxBytes: 512 * 1024 * 1024,
    });
    const runs = new RunManager({
      store,
      deps: () => ({
        browser: createBrowserAdapter({
          request,
          profile: "chrome",
          blobs: {
            put: async (bytes, contentType) =>
              (await blobs.put(bytes, { contentType, metadata: { kind: "screenshot" } })).id,
          },
        }),
        ai: createAiAdapter({ request, sessionKey: "main" }),
        ask: createAskAdapter({ request, sessionKey: "main" }),
        cred: (key) => credGet(key),
      }),
      emit: (event) => events.emit("run", event),
    });
    api.registerService({
      id: "duties:runs",
      async start() {
        await runs.recoverOrphans();
      },
      stop() {},
    });
    registerDutiesGatewayMethods({
      api,
      store,
      runs,
      emit: (name, payload) => events.emit(name, payload),
    });
  },
});
```

Check `openBlobStore`'s option names and `put` signature in `src/plugin-state/plugin-blob-store.types.ts` and adjust (`maxBytes`, `put(bytes, {contentType, metadata})`, returned `id`). Update `index.test.ts` to mock `./src/store.js` like Workboard does (`vi.mock("./src/store.js", () => ({ DutyStore: { open: () => ({}) } }))`) so registration stays testable without SQLite.

- [ ] **Step 4: Run both tests** → PASS.
- [ ] **Step 5: Commit** — `git add extensions/duties && git commit -m "feat(duties): wire store, run manager, events and gateway methods"`

---

### Task 10: Agent tools and the authoring skill

**Files:**

- Create: `extensions/duties/src/tools.ts`, `extensions/duties/src/tools.test.ts`, `extensions/duties/skills/duties/SKILL.md`
- Modify: `extensions/duties/index.ts` (call `registerDutyTools`)

**Interfaces:**

- Consumes: `DutyStore`, `RunManager`, `validateDuty`, `credHas` (Tasks 3, 8, 2, 4); `api.registerTool(tool, { name })` where a tool is `{ name, label, description, parameters (TypeBox), execute(toolCallId, input, signal) }` returning `jsonResult(...)` from `openclaw/plugin-sdk/tool-result` (confirm the helper's subpath with `grep -n jsonResult scripts/lib/plugin-sdk-entrypoints.json`; Workboard's `src/tools.ts` shows the exact import).
- Produces tools:
  - `duty_list {}` → duties (id, name, status, summary)
  - `duty_get { id }` → full duty + last 5 successful runs
  - `duty_draft { id, name, summary, machine?, reportsTo?, exclusive?, inputs?, triggers? }` → creates (status `building`) or updates header fields; keeps existing steps
  - `duty_set_steps { id, steps }` → validates (`validateDuty`), saves; returns errors verbatim on failure
  - `duty_run { id, inputs?, toStepId?, keepOpen?, targetId? }` → starts a run and **waits** for it (`runs.wait`), returning `{ status, steps, outputs, failedStep, report, targetId }`
  - `duty_save { id }` → sets `status: "active"`
  - `cred_needed { key, reason }` → `{ stored: boolean, howTo: "Ask the owner to open Duties → Logins and save the key <key>, or run: openclaw duties cred set <key>" }` — never accepts a value
- The skill tells the agent the authoring loop from the spec §2, the step vocabulary from §1.2 with the `params.action` names above, the login-gateway shape, and the rule "labels in the owner's words, targets by role+name/text/css, never a ref".

- [ ] **Step 1: Failing test**

```ts
// extensions/duties/src/tools.test.ts
import { describe, expect, it, vi } from "vitest";
import { registerDutyTools } from "./tools.js";
import { DutyStore } from "./store.js";

function memoryKeyed<T>() {
  const m = new Map<string, T>();
  return {
    register: async (k: string, v: T) => {
      m.set(k, v);
    },
    lookup: async (k: string) => m.get(k),
    entries: async () => [...m].map(([key, value]) => ({ key, value })),
    delete: async (k: string) => m.delete(k),
  };
}

describe("duty tools", () => {
  it("drafts, sets steps, and refuses invalid steps with the validation errors", async () => {
    const tools = new Map<
      string,
      { execute: (id: string, input: unknown) => Promise<{ content: Array<{ text: string }> }> }
    >();
    const api = {
      registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool as never),
    } as never;
    const store = new DutyStore({ duties: memoryKeyed() as never, runs: memoryKeyed() as never });
    registerDutyTools({
      api,
      store,
      runs: { start: vi.fn(), wait: vi.fn() } as never,
      credHas: async () => false,
    });
    const run = async (name: string, input: unknown) =>
      JSON.parse((await tools.get(name)!.execute("c1", input)).content[0]!.text);
    await run("duty_draft", { id: "d1", name: "Book flight", summary: "books" });
    expect((await run("duty_list", {})).duties[0]).toMatchObject({ id: "d1", status: "building" });
    const bad = await run("duty_set_steps", {
      id: "d1",
      steps: [{ id: "s1", kind: "browser", label: "#btnlogin", params: {} }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toContain("label");
    const good = await run("duty_set_steps", {
      id: "d1",
      steps: [
        {
          id: "s1",
          kind: "browser",
          label: "Open Amigos",
          params: { action: "open", url: "https://x" },
        },
      ],
    });
    expect(good.ok).toBe(true);
    expect((await run("cred_needed", { key: "amigos.password", reason: "login" })).stored).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `tools.ts`** — one `api.registerTool` per tool with TypeBox `parameters`; each `execute` returns `jsonResult(payload)`. `duty_run` calls `runs.start` then `runs.wait` and returns the run's `status/steps/outputs/failedStep/report` plus `targetId` from the outcome (store it on the run record as `run.targetId` when `keepOpen`; add the optional field to `DutyRun` in `store.ts`). Write `skills/duties/SKILL.md` (frontmatter `name: duties`, `description: Build and run Duties — saved, replayable automations — from the owner's instructions`) covering: the loop (understand → explore with the browser tool → ask → write steps for one stage → `duty_run` with `toStepId` + `keepOpen` → continue from `targetId` → repeat → `duty_save`), the step vocabulary with `params.action` names and examples, the login gateway (`when` + `visible` probe + `{{cred:*}}` fills + OTP `ask` inside `when text_matches`), the rule to call `cred_needed` instead of ever asking for a password in chat, and "labels in the owner's words".
- [ ] **Step 4: Run → PASS. Register the tools in `index.ts`: `registerDutyTools({ api, store, runs, credHas: (key) => credHas(key) })`; re-run `index.test.ts`.**
- [ ] **Step 5: Commit** — `git add extensions/duties && git commit -m "feat(duties): agent tools and authoring skill"`

---

### Task 11: Control UI page wired to the Gateway

**Files:**

- Create: `extensions/duties/browser/index.ts`, `extensions/duties/browser/styles.css`, `extensions/duties/browser/render.ts`, `extensions/duties/browser/render.test.ts`
- Source: copy `~/Developer/duties-ui-spike/src/control-ui.ts` and `control-ui.css`; the CSS moves unchanged; the TypeScript is split into `render.ts` (pure `renderBoard(duties, runs)`, `renderDetail(duty, runs)`, `renderRun(run, duty)`; no DOM) and `index.ts` (host wiring).

**Interfaces:**

- Consumes: `host.request("duties.list")`, `("duties.get", {id})`, `("duties.run", {id})`, `("duties.run.get", {runId})`, `("duties.status", {id, status})`, `("duties.delete", {id})`; events `plugin.duties.changed`, `plugin.duties.run`; `host.ui.registerPage/registerNavigation`, `host.navigation.openPage({ id: "duties", params: { view, id, runId } })`.
- Behavior: Board (rollups computed from real duties/runs; banner for the newest `failed`/`blocked` run), Duty page (steps read-only; runs = successful only; Run button → `duties.run` then navigates to the run view), Run view (live: re-fetches `duties.run.get` on each `plugin.duties.run` event for that `runId`; step list is the progress display). Build session view stays as the spike's static example until Part 2 wires the chat mirror. "Edit with agent" opens the Chat page via `host.navigation.openPage({ id: "chat" })` with the draft text `Edit the Duty "<name>"` set through `host.sessions` only if the host API allows; otherwise show the instruction text.

- [ ] **Step 1: Failing render tests** (pure functions; run under the extensions vitest config with `// @vitest-environment jsdom` if DOM is needed — prefer string output so no DOM is required):

```ts
// extensions/duties/browser/render.test.ts
import { describe, expect, it } from "vitest";
import { renderBoard, renderDetail } from "./render.js";
const duty = {
  id: "d1",
  name: "Book flight",
  summary: "s",
  status: "active",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 0,
  steps: [{ id: "s1", kind: "ask", label: "Confirm?", params: {} }],
} as const;
describe("render", () => {
  it("board shows the duty with its status and no Draft anywhere", () => {
    const html = renderBoard([duty as never], []);
    expect(html).toContain("Book flight");
    expect(html).toContain("Active");
    expect(html).not.toMatch(/draft/iu);
  });
  it("detail lists successful runs only and highlights ask steps", () => {
    const html = renderDetail(
      duty as never,
      [
        {
          id: "r1",
          dutyId: "d1",
          status: "ok",
          startedAt: 1,
          trigger: "manual",
          inputs: {},
          outputs: {},
          steps: [],
        },
        {
          id: "r2",
          dutyId: "d1",
          status: "failed",
          startedAt: 2,
          trigger: "manual",
          inputs: {},
          outputs: {},
          steps: [],
        },
      ] as never,
    );
    expect(html).toContain("r1");
    expect(html).not.toContain("r2");
    expect(html).toContain('class="kind ask"');
  });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Port the spike**: move the render functions into `render.ts` taking real `Duty`/`DutyRun` types (import the types from `../src/duty.js` and `../src/store.js` — browser bundles may import types only; keep runtime imports out), write `index.ts` with `defineControlUiPlugin` (page id `duties`, navigation `listChecks`, order 15), fetch via `host.request`, subscribe to both events, re-render on change; keep all CSS class names `dt*`.
- [ ] **Step 4: Run render tests → PASS. Build the bundle:** `cd extensions/duties && node --import ../../scripts/tsx.mjs ../../scripts/build-plugin-control-ui.mts` → `openclaw.plugin.json.controlUi` filled; `git diff --stat` shows `dist/control-ui/<hash>` is ignored or committed the same way Workboard's is (check `git check-ignore extensions/workboard/dist` and follow it).
- [ ] **Step 5: Commit** — `git add extensions/duties && git commit -m "feat(duties): control UI page wired to duties.* methods and events"`

---

### Task 12: Live proof on the fork's Gateway (Amigos login + search stages)

**Files:**

- Create: `docs/superpowers/plans/2026-09-13-duties-core-part1-proof.md` (evidence notes; `git add -f`)

**Interfaces:** none new. This task proves acceptance items 1–3 of the spec for the browser stages.

- [ ] **Step 1: Build the fork** — `pnpm build` (check `package.json` `scripts.build`; if it needs native deps skipped by `--ignore-scripts`, run `npx pnpm@12.3.4 rebuild` for the failing package and note it).
- [ ] **Step 2: Run the fork's Gateway isolated from the live one** — copy the live config: `mkdir -p ~/.openclaw-duties && cp ~/.openclaw/openclaw.json ~/.openclaw-duties/`, edit the copy's `gateway.port` to `19001` and remove `channels.telegram` (so the live bot is untouched), then `OPENCLAW_STATE_DIR=~/.openclaw-duties OPENCLAW_CONFIG_PATH=~/.openclaw-duties/openclaw.json pnpm openclaw gateway run --port 19001`. Sign in to `http://127.0.0.1:19001` in Chrome with `OPENCLAW_STATE_DIR=~/.openclaw-duties pnpm openclaw gateway auth-token --show` (run in a real terminal). The Chrome extension pairs with whichever Gateway wakes it; run the proof with the live Gateway stopped (`openclaw gateway stop`) and restart it afterwards (`openclaw gateway start`) — tell the owner before doing this.
- [ ] **Step 3: Author through chat** — in the Control UI chat: "Make a Duty 'Amigos search' that signs in to amigosalliance.co.in if needed, using credentials amigos.username/amigos.password, then searches one way DEL→BOM on 27 Sep 2026 for 1 adult and stops on the results page." Expect the agent to call `cred_needed`, you save the two keys on Logins (or via `credSet` in a terminal), then `duty_draft`, `duty_set_steps`, `duty_run` with `toStepId`, and `duty_save`.
- [ ] **Step 4: Run it twice concurrently from the Duty page and once from a second Duty** — confirm two tabs, both runs `ok`, the exclusive case queues with the reason, evidence rows with screenshots in the run view.
- [ ] **Step 5: Record** what worked, what needed a fix, screenshots paths, and the exact response shapes you had to adjust in Tasks 6–7, in the proof doc; commit with `git add -f`.

---

## Self-review

- **Spec coverage:** §1.1 document → Task 2; §1.2 browser/evaluate/ai/ask/cred/when/stop → Tasks 4–7; `for-each`, `template`, `deliver`, `file/print`, `mcp` → Part 2 (noted in header); §2 authoring → Task 10 (tools + skill); §3 runner, concurrency, evidence, `lost` → Tasks 5, 8, 9; §4 manual trigger → Task 9/11; schedule/mail/channel/webhook triggers → Part 2; §5 storage → Task 3/9; §6 UI board/detail/run → Task 11 (build session live chat mirror and machine view → Part 2); §7 constraints → Global Constraints; §9 acceptance 1–3 → Task 12.
- **Placeholders:** none; two "confirm the exact field names before running" notes point at specific files rather than leaving code undefined.
- **Type consistency:** `RunStatus`, `StepEvidence`, `DutyRun` defined once in Task 3 and reused; `RunnerDeps`/`BrowserAdapter`/`AiAdapter`/`AskAdapter` from Task 5 reused in 6–9; `validateDuty` signature identical in Tasks 2, 9, 10.
