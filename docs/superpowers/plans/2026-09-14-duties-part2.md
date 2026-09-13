# Duties Part 2 — triggers, templates → PDF, deliver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the flight-search Duty work end to end: a request arrives by Gmail or chat, the Duty runs, renders a branded PDF of the options, and delivers it to the triggering chat or the owner.

**Architecture:** Every trigger is an agent turn that ends in `duty_run` (a dedicated, tool-restricted `duties-mail` agent for Gmail; the owner's agent for chat). `duty_run` records the run's origin from the tool context. Two new deterministic step kinds — `template` (slot substitution + one `llm-task` call for prose slots, HTML served to the managed browser over a one-time Gateway route and printed with the browser plugin's `/pdf`) and `deliver` (`sendDurableMessageBatch` to the origin route or the owner target) — run inside the plugin with no model. Templates, a brand, and owner settings live in the plugin's keyed store; rendered files live under the plugin's state dir.

**Tech Stack:** TypeScript ESM, `openclaw/plugin-sdk/*` (`plugin-entry`, `core`, `channel-outbound`, `session-store-runtime`, `string-coerce-runtime`, `error-runtime`, `control-ui`), typebox 1.3.27, vitest via `node scripts/run-vitest.mjs`, tsgo lanes, oxfmt.

**Spec:** `docs/superpowers/specs/2026-09-14-duties-part2-triggers-templates-deliver-design.md` (builds on `docs/superpowers/specs/2026-09-13-duties-core-design.md`).

**Deviations from the spec, decided while planning (the spec is updated in Task 1):**

- The owner delivery target lives in the plugin's keyed store (`settings` namespace, set on the Duties page) instead of `plugins.entries.duties.config.owner` — no config-surface growth, no doc-baseline bump.
- Rendered HTML cannot be opened as `file://`/`data:` (the browser plugin's navigation guard allows only http(s)); the plugin serves it once over a Gateway HTTP route (`auth: "plugin"`, single-use token, 60 s TTL) and the managed profile opens that URL.
- Rendered PDFs are files under `<stateDir>/plugins/duties/files/<runId>/`, not blob-store entries (the blob store exposes no path, and delivery needs one).
- `openclaw duties setup-mail` prints the exact config snippets and commands and verifies prerequisites; it does not mutate `openclaw.json` (no plugin-owned config mutation contract exists).
- The Gmail hook payload documents only `id, from, subject, snippet, body`; `threadId` is not relied on.

## Global Constraints

- Plugin code imports only `openclaw/plugin-sdk/*`, node builtins, and typebox; never `src/**` or another extension's files.
- Every non-const `as` assertion has `// SAFETY: <invariant>` (test files included; the ratchet scans them).
- Reuse `isRecord` from `openclaw/plugin-sdk/string-coerce-runtime`; no new coercion helpers.
- `{{cred:…}}` stays confined to a browser `fill`/`select` `params.value`; a credential value never reaches a template, a message, a log, or the model.
- No new npm dependencies.
- TDD: write the failing test first for every behavioral change; tests fail on the original defect.
- Gates per task, FOREGROUND only, never concurrently with another tsgo/check-changed: `node scripts/run-vitest.mjs extensions/duties`; `pnpm tsgo:extensions`; `node --import ./scripts/tsx.mjs scripts/check-assertion-safety-ratchet.mts --base origin/main`; `pnpm exec oxfmt --write <changed files>`. The controller runs `node scripts/check-changed.mjs`.
- Shell prefix for every command: `export PATH="/private/tmp/claude-501/-Users-pulkitshah-Developer-vasudev-openclaw/27667f8d-d1d5-4e9c-9ae4-83e02226504a/scratchpad/bin:$HOME/.nvm/versions/node/v26.8.2/bin:$PATH"`. Never `pnpm install`.
- Commit messages: Conventional Commits, ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01HqBDjTY3KJDDioiMg5wXUy`.
- UI bundle: when `browser/*` changes, rebuild with `node --import ../../scripts/tsx.mjs ../../scripts/build-plugin-control-ui.mts` from `extensions/duties` and commit the updated `openclaw.plugin.json` hash with the UI change (same recipe as Part 1).
- Docs under `docs/superpowers/**` are gitignored: commit them with `git add -f`; no personal paths or hostnames in them.

---

## File structure

| File                                                                                     | Responsibility                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/duties/src/duty.ts` (modify)                                                 | Duty model: triggers `manual/mail/chat`, input sources `mail/file`, step kinds `template/deliver`, per-kind param validation, nested `{{in:…}}`, `{{file:…}}` placeholders, `validateRunInputs` |
| `extensions/duties/src/template.ts` (create)                                             | Template/Brand types, `validateTemplate`, pure `renderTemplate` (slot/rows/brand substitution, escaping)                                                                                        |
| `extensions/duties/src/store.ts` (modify)                                                | `DutyRun.origin`/`files`; namespaces `templates`, `brands`, `settings`; `appendRunFile`                                                                                                         |
| `extensions/duties/src/files.ts` (create)                                                | Run/preview file directories under the state dir, `cleanupRunFiles(olderThanMs)`                                                                                                                |
| `extensions/duties/src/adapters/render.ts` (create)                                      | `createRenderServer` (one-time HTML route) + `createRenderAdapter` (open URL in managed tab → `/pdf` → copy to dest)                                                                            |
| `extensions/duties/src/adapters/browser.ts` (modify)                                     | `pdf(targetId)` on `BrowserAdapter`                                                                                                                                                             |
| `extensions/duties/src/adapters/deliver.ts` (create)                                     | `resolveDeliverRoute` + `createDeliverAdapter` over `sendDurableMessageBatch`                                                                                                                   |
| `extensions/duties/src/runner.ts` (modify)                                               | `template` and `deliver` steps, `origin`, `files`, `{{file:}}` resolution                                                                                                                       |
| `extensions/duties/src/run-service.ts` (modify)                                          | origin on start, per-run files dir, `onFile`, status lines to the triggering chat                                                                                                               |
| `extensions/duties/src/tools.ts` (modify)                                                | `duty_run` as a factory capturing origin + input validation; `template_*`, `brand_*` tools                                                                                                      |
| `extensions/duties/src/gateway-methods.ts` (modify)                                      | `duties.template.*`, `duties.brand.*`, `duties.settings.*`, `duties.run.file`, `duties.mail.status`                                                                                             |
| `extensions/duties/src/cli.ts` (create)                                                  | `openclaw duties setup-mail --account <email>`                                                                                                                                                  |
| `extensions/duties/index.ts` (modify)                                                    | wiring: render server route, adapters, files dir, CLI                                                                                                                                           |
| `extensions/duties/openclaw.plugin.json` (modify)                                        | tool contracts list                                                                                                                                                                             |
| `extensions/duties/skills/duties/SKILL.md` (modify)                                      | dispatch section, template/deliver vocabulary, authoring loop for templates                                                                                                                     |
| `extensions/duties/browser/render.ts`, `browser/index.ts`, `browser/styles.css` (modify) | trigger chips, run files/deliver rows, Templates page + brand form, settings strip, mail health                                                                                                 |

---

### Task 1: Duty model — triggers, inputs, step kinds, placeholders

**Files:**

- Modify: `extensions/duties/src/duty.ts`
- Modify: `extensions/duties/src/store.ts` (types only: `RunOrigin`, `RunFile`, `DutyRun.origin/files`)
- Modify: `docs/superpowers/specs/2026-09-14-duties-part2-triggers-templates-deliver-design.md` (record the five deviations listed in the header; `git add -f`)
- Test: `extensions/duties/src/duty.test.ts`

**Interfaces:**

- Consumes: Part 1 `validateDuty`, `resolvePlaceholders`, `Step`, `DutyNode`.
- Produces:

  ```ts
  export type DutyTrigger =
    { kind: "manual" } | { kind: "mail"; match: string } | { kind: "chat"; match: string };
  export type DutyInput = {
    name: string;
    source: "ask" | "file" | "mail" | "trigger" | "cred" | "literal";
    prompt?: string;
    value?: string;
    required?: boolean;
  };
  export type StepKind = "browser" | "browser.evaluate" | "ai" | "ask" | "template" | "deliver"; // un-exported const STEP_KINDS updated
  export type TemplateFill = { from: string } | { ai: string };
  export function validateRunInputs(duty: Duty, inputs: Record<string, unknown>): string[]; // [] when ok
  export async function resolvePlaceholders(
    value: string,
    ctx: { out; in; cred?; file?: (stepId: string) => string | undefined },
  ): Promise<string>;
  // store.ts
  export type RunOrigin = {
    kind: "chat" | "mail" | "manual";
    sessionKey?: string;
    agentId?: string;
    channel?: string;
    accountId?: string;
  };
  export type RunFile = {
    stepId: string;
    name: string;
    path: string;
    bytes: number;
    contentType: string;
  };
  // DutyRun gains `origin?: RunOrigin; files?: RunFile[]`
  ```

- [ ] **Step 1: Write the failing tests** (append to `duty.test.ts`)

```ts
describe("Part 2 model", () => {
  const base = () => ({
    id: "t",
    name: "T",
    summary: "",
    status: "active",
    machine: "gateway",
    reportsTo: "owner",
    inputs: [],
    steps: [],
    triggers: [{ kind: "manual" }],
    updatedAt: 1,
  });

  it("accepts mail and chat triggers with a match and rejects them without one", () => {
    const ok = validateDuty({
      ...base(),
      triggers: [
        { kind: "mail", match: "travel requests" },
        { kind: "chat", match: "a forwarded request" },
      ],
    });
    expect(ok.ok).toBe(true);
    const bad = validateDuty({ ...base(), triggers: [{ kind: "mail" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join()).toMatch(/triggers\[0\]\.match/u);
  });

  it("validates template and deliver step params", () => {
    const good = validateDuty({
      ...base(),
      steps: [
        {
          id: "t1",
          kind: "template",
          label: "Render options",
          params: {
            template: "flight-options",
            fill: { route: { from: "{{out:route}}" }, notes: { ai: "Summarize" } },
          },
        },
        {
          id: "d1",
          kind: "deliver",
          label: "Send it",
          params: { to: "trigger", text: "Here you go", files: ["{{file:t1}}"] },
        },
      ],
    });
    expect(good.ok).toBe(true);
    const bad = validateDuty({
      ...base(),
      steps: [
        { id: "t1", kind: "template", label: "Render", params: { fill: { x: { nope: 1 } } } },
        { id: "d1", kind: "deliver", label: "Send", params: { to: "someone" } },
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join("\n")).toMatch(/params\.template: must be a non-empty string/u);
      expect(bad.errors.join("\n")).toMatch(/params\.fill\.x: must be \{ from \} or \{ ai \}/u);
      expect(bad.errors.join("\n")).toMatch(
        /params\.channel: required when to is not "trigger" or "owner"/u,
      );
    }
  });

  it("rejects a cred placeholder inside template fill and deliver text", () => {
    const bad = validateDuty({
      ...base(),
      steps: [
        {
          id: "d1",
          kind: "deliver",
          label: "Send",
          params: { to: "owner", text: "{{cred:site.password}}" },
        },
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it("resolves nested input paths and file placeholders", async () => {
    const out = await resolvePlaceholders(
      "{{in:mail.attachments.0.text}} / {{in:mail.subject}} / {{file:t1}}",
      {
        out: {},
        in: { mail: { subject: "Ref G703", attachments: [{ text: "PDF TEXT" }] } },
        file: (id) => (id === "t1" ? "/tmp/x.pdf" : undefined),
      },
    );
    expect(out).toBe("PDF TEXT / Ref G703 / /tmp/x.pdf");
    await expect(resolvePlaceholders("{{file:zz}}", { out: {}, in: {} })).rejects.toThrow(
      /no file from step "zz"/u,
    );
  });

  it("validateRunInputs requires declared mail/file inputs with the right shape", () => {
    const duty = {
      ...base(),
      inputs: [
        { name: "mail", source: "mail" },
        { name: "sheet", source: "file", required: false },
      ],
    };
    // SAFETY: test fixture shaped like a Duty; validateRunInputs only reads inputs[].
    const d = duty as unknown as Duty;
    expect(validateRunInputs(d, {})).toEqual(['input "mail" is required']);
    expect(validateRunInputs(d, { mail: { from: "a@b", subject: "s" } })).toEqual([
      'input "mail": body must be a string',
    ]);
    expect(validateRunInputs(d, { mail: { from: "a@b", subject: "s", body: "b" } })).toEqual([]);
    expect(
      validateRunInputs(d, {
        mail: { from: "a@b", subject: "s", body: "b" },
        sheet: { name: "x" },
      }),
    ).toEqual(['input "sheet": path must be a string']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node scripts/run-vitest.mjs extensions/duties/src/duty.test.ts`
Expected: FAIL — `validateRunInputs` is not exported; template/deliver kinds rejected as unknown.

- [ ] **Step 3: Implement in `duty.ts`**

Replace the trigger/input/step-kind declarations and add validation:

```ts
export type StepKind = "browser" | "browser.evaluate" | "ai" | "ask" | "template" | "deliver";
const STEP_KINDS: readonly StepKind[] = [
  "browser",
  "browser.evaluate",
  "ai",
  "ask",
  "template",
  "deliver",
];
export type TemplateFill = { from: string } | { ai: string };
export type DutyInput = {
  name: string;
  source: "ask" | "file" | "mail" | "trigger" | "cred" | "literal";
  prompt?: string;
  value?: string;
  /** Only meaningful for `mail`/`file`: default true — a run without it fails before step 1. */
  required?: boolean;
};
export type DutyTrigger =
  { kind: "manual" } | { kind: "mail"; match: string } | { kind: "chat"; match: string };
const INPUT_SOURCES = ["ask", "file", "mail", "trigger", "cred", "literal"] as const;
const TRIGGER_KINDS = ["manual", "mail", "chat"] as const;
const DELIVER_ROUTES = ["trigger", "owner"] as const;
```

In `validateDuty`, replace the inline `sources`/`kinds` arrays with `INPUT_SOURCES`/`TRIGGER_KINDS` and add, inside the triggers loop after the kind check:

```ts
if (
  (trg.kind === "mail" || trg.kind === "chat") &&
  (typeof trg.match !== "string" || !trg.match.trim())
)
  errors.push(`triggers[${idx}].match: must be a non-empty string`);
```

Extend `validateStepParams` with per-kind checks (keep the cred walk it already does):

```ts
function validateStepParams(node: Record<string, unknown>, path: string, errors: string[]): void {
  if (!isRecord(node.params)) return;
  const params = node.params;
  const credValueAllowed =
    node.kind === "browser" && (params.action === "fill" || params.action === "select");
  for (const [key, value] of Object.entries(params)) {
    if (credValueAllowed && key === "value" && typeof value === "string") continue;
    rejectCredStrings(value, `${path}.params.${key}`, errors);
  }
  if (node.kind === "template") validateTemplateParams(params, `${path}.params`, errors);
  if (node.kind === "deliver") validateDeliverParams(params, `${path}.params`, errors);
}

function validateTemplateParams(
  params: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (typeof params.template !== "string" || !params.template.trim())
    errors.push(`${path}.template: must be a non-empty string`);
  if (params.format !== undefined && params.format !== "pdf" && params.format !== "message")
    errors.push(`${path}.format: must be pdf or message`);
  if (!isRecord(params.fill)) {
    errors.push(`${path}.fill: must be an object of slot → { from } | { ai }`);
    return;
  }
  for (const [slot, fill] of Object.entries(params.fill)) {
    const okFrom =
      isRecord(fill) && typeof fill.from === "string" && Object.keys(fill).length === 1;
    const okAi =
      isRecord(fill) &&
      typeof fill.ai === "string" &&
      fill.ai.trim() &&
      Object.keys(fill).length === 1;
    if (!okFrom && !okAi) errors.push(`${path}.fill.${slot}: must be { from } or { ai }`);
  }
}

function validateDeliverParams(
  params: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (typeof params.to !== "string" || !params.to.trim()) {
    errors.push(`${path}.to: must be "trigger", "owner", or a channel target`);
    return;
  }
  // SAFETY: includes() is the runtime check; the cast only lets an arbitrary string be compared.
  const explicit = !DELIVER_ROUTES.includes(params.to as (typeof DELIVER_ROUTES)[number]);
  if (explicit && (typeof params.channel !== "string" || !params.channel.trim()))
    errors.push(`${path}.channel: required when to is not "trigger" or "owner"`);
  if (params.text !== undefined && typeof params.text !== "string")
    errors.push(`${path}.text: must be a string`);
  if (
    params.files !== undefined &&
    (!Array.isArray(params.files) || params.files.some((f) => typeof f !== "string"))
  )
    errors.push(`${path}.files: must be an array of {{file:<stepId>}} strings`);
  if (params.text === undefined && params.files === undefined)
    errors.push(`${path}: deliver needs text and/or files`);
}
```

Run-input validation (new export, placed after `validateDuty`):

```ts
/** Checks the inputs handed to a run against the Duty's declared `mail`/`file` inputs. Returns
 *  one message per problem; an empty array means the run may start. */
export function validateRunInputs(duty: Duty, inputs: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const input of duty.inputs) {
    if (input.source !== "mail" && input.source !== "file") continue;
    const value = inputs[input.name];
    if (value === undefined) {
      if (input.required !== false) errors.push(`input "${input.name}" is required`);
      continue;
    }
    if (!isRecord(value)) {
      errors.push(`input "${input.name}": must be an object`);
      continue;
    }
    const need = input.source === "mail" ? ["from", "subject", "body"] : ["name", "path"];
    for (const field of need) {
      if (typeof value[field] !== "string")
        errors.push(`input "${input.name}": ${field} must be a string`);
    }
  }
  return errors;
}
```

Placeholders — nested `in` paths and `file` scope:

```ts
const PLACEHOLDER_RE = /\{\{(out|in|cred|file):([A-Za-z0-9_.-]+)\}\}/gu;

function readPath(root: unknown, dotted: string): unknown {
  let cur: unknown = root;
  for (const segment of dotted.split(".")) {
    if (Array.isArray(cur)) cur = cur[Number(segment)];
    else if (isRecord(cur)) cur = cur[segment];
    else return undefined;
  }
  return cur;
}

export async function resolvePlaceholders(
  value: string,
  ctx: {
    out: Record<string, unknown>;
    in: Record<string, unknown>;
    cred?: (key: string) => Promise<string>;
    /** Path of the file a `template` step produced; only `deliver`/`template` params may use it. */
    file?: (stepId: string) => string | undefined;
  },
): Promise<string> {
  let result = value;
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    const whole = match[0];
    const scope = match[1];
    const key = match[2];
    if (!whole || !scope || !key) continue;
    let replacement = "";
    if (scope === "out") replacement = stringify(readPath(ctx.out, key));
    else if (scope === "in") replacement = stringify(readPath(ctx.in, key));
    else if (scope === "file") {
      const path = ctx.file?.(key);
      if (!path) throw new Error(`no file from step "${key}"`);
      replacement = path;
    } else {
      if (!ctx.cred) throw new Error(`no credential stored for ${key}`);
      replacement = await ctx.cred(key);
    }
    result = result.replaceAll(whole, () => replacement);
  }
  return result;
}
```

`store.ts` types (no behavior yet):

```ts
export type RunOrigin = {
  kind: "chat" | "mail" | "manual";
  sessionKey?: string;
  agentId?: string;
  channel?: string;
  accountId?: string;
};
export type RunFile = { stepId: string; name: string; path: string; bytes: number; contentType: string };
// in DutyRun:
  origin?: RunOrigin;
  files?: RunFile[];
```

- [ ] **Step 4: Run tests** — `node scripts/run-vitest.mjs extensions/duties` → all pass (Part 1 tests still green; the UI's `triggerChips`/`triggerRow` reference `"webhook"` — fix them in Task 9; until then `pnpm tsgo:extensions` may flag `browser/render.ts`. If it does, update those two functions now to `t.kind === "mail" ? "Mail" : t.kind === "chat" ? "Chat" : "Manual"` and `Manual (chat or Run button)` / the `match` text as detail).

- [ ] **Step 5: Spec deviations** — add a "Planning deviations" subsection under §1 of the Part 2 spec with the five bullets from this plan's header.

- [ ] **Step 6: Gates and commit**

```bash
git add extensions/duties/src/duty.ts extensions/duties/src/duty.test.ts extensions/duties/src/store.ts extensions/duties/browser/render.ts
git add -f docs/superpowers/specs/2026-09-14-duties-part2-triggers-templates-deliver-design.md
git commit -m "feat(duties): mail/chat triggers, mail/file inputs, template and deliver step contracts"
```

---

### Task 2: Template engine (`template.ts`)

**Files:**

- Create: `extensions/duties/src/template.ts`
- Test: `extensions/duties/src/template.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type TemplateSlot = {
    name: string;
    kind: "text" | "rows" | "prose";
    description: string;
    columns?: string[];
  };
  export type Template = {
    id: string;
    name: string;
    kind: "pdf" | "message";
    html: string;
    slots: TemplateSlot[];
    updatedAt: number;
  };
  export type Brand = {
    name: string;
    logoDataUrl?: string;
    primary?: string;
    accent?: string;
    phone?: string;
    email?: string;
    footer?: string;
    updatedAt: number;
  };
  export function validateTemplate(
    input: unknown,
  ): { ok: true; template: Template } | { ok: false; errors: string[] };
  export function validateBrand(
    input: unknown,
  ): { ok: true; brand: Brand } | { ok: false; errors: string[] };
  export function renderTemplate(
    template: Template,
    data: Record<string, unknown>,
    brand?: Brand,
  ): { ok: true; output: string } | { ok: false; missing: string[] };
  export function placeholderData(template: Template): Record<string, unknown>; // sample data for previews
  ```
- Slot syntax: `{{slot:name}}`, `{{#rows:name}}…{{col:column}}…{{/rows:name}}`, `{{brand:field}}`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { placeholderData, renderTemplate, validateTemplate, type Template } from "./template.js";

const tpl: Template = {
  id: "flight-options",
  name: "Flight options",
  kind: "pdf",
  updatedAt: 1,
  html: `<h1>{{brand:name}}</h1><p>{{slot:route}} on {{slot:date}}</p><table>{{#rows:flights}}<tr><td>{{col:airline}}</td><td>{{col:fare}}</td></tr>{{/rows:flights}}</table><p>{{slot:notes}}</p>`,
  slots: [
    { name: "route", kind: "text", description: "From → To" },
    { name: "date", kind: "text", description: "Travel date" },
    {
      name: "flights",
      kind: "rows",
      description: "One row per option",
      columns: ["airline", "fare"],
    },
    { name: "notes", kind: "prose", description: "Short advice" },
  ],
};

describe("validateTemplate", () => {
  it("requires every html placeholder to be declared and every slot to be used", () => {
    const r = validateTemplate({ ...tpl, html: "{{slot:route}} {{slot:ghost}}" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('html uses undeclared slot "ghost"');
      expect(r.errors).toContain('slot "date" is declared but not used in html');
    }
  });
  it("requires columns on rows slots and a kebab-case id", () => {
    const r = validateTemplate({
      ...tpl,
      id: "Flight Options",
      slots: tpl.slots.map((s) => (s.kind === "rows" ? { ...s, columns: [] } : s)),
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors).toEqual(
        expect.arrayContaining([
          "id must be a kebab-case slug",
          'slot "flights": rows slots need at least one column',
        ]),
      );
  });
});

describe("renderTemplate", () => {
  it("substitutes text, rows, prose and brand, escaping html in pdf templates", () => {
    const r = renderTemplate(
      tpl,
      {
        route: "IXU → COK",
        date: "02 Oct 2026",
        flights: [{ airline: "IndiGo <6E>", fare: "₹27,772" }],
        notes: "Agency fare",
      },
      { name: "Amigos & Co", updatedAt: 1 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain("<h1>Amigos &amp; Co</h1>");
      expect(r.output).toContain("<td>IndiGo &lt;6E&gt;</td><td>₹27,772</td>");
      expect(r.output).not.toContain("{{");
    }
  });
  it("reports every unfilled slot instead of rendering blanks", () => {
    const r = renderTemplate(tpl, { route: "x", flights: "not an array" });
    expect(r).toEqual({ ok: false, missing: ["date", "flights", "notes"] });
  });
  it("message templates are not html-escaped", () => {
    const m: Template = {
      ...tpl,
      kind: "message",
      html: "Options for {{slot:route}}",
      slots: [tpl.slots[0]!],
    };
    const r = renderTemplate(m, { route: "A & B" });
    expect(r).toEqual({ ok: true, output: "Options for A & B" });
  });
  it("placeholderData fills every slot with a sample", () => {
    const d = placeholderData(tpl);
    expect(d.route).toBe("[route]");
    expect(d.flights).toEqual([{ airline: "[airline]", fare: "[fare]" }]);
    expect(renderTemplate(tpl, d).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail** — module not found.

- [ ] **Step 3: Implement `template.ts`**

```ts
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type TemplateSlot = {
  name: string;
  kind: "text" | "rows" | "prose";
  description: string;
  columns?: string[];
};
export type Template = {
  id: string;
  name: string;
  kind: "pdf" | "message";
  /** For `pdf`: an HTML document body; for `message`: plain text. Slots use {{slot:name}},
   *  rows use {{#rows:name}}…{{col:column}}…{{/rows:name}}, brand fields {{brand:field}}. */
  html: string;
  slots: TemplateSlot[];
  updatedAt: number;
};
export type Brand = {
  name: string;
  logoDataUrl?: string;
  primary?: string;
  accent?: string;
  phone?: string;
  email?: string;
  footer?: string;
  updatedAt: number;
};

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NAME_RE = /^[A-Za-z0-9_-]+$/u;
const SLOT_RE = /\{\{slot:([A-Za-z0-9_-]+)\}\}/gu;
const ROWS_RE = /\{\{#rows:([A-Za-z0-9_-]+)\}\}([\s\S]*?)\{\{\/rows:\1\}\}/gu;
const COL_RE = /\{\{col:([A-Za-z0-9_-]+)\}\}/gu;
const BRAND_RE = /\{\{brand:(name|logoDataUrl|primary|accent|phone|email|footer)\}\}/gu;
const BRAND_FIELDS = [
  "name",
  "logoDataUrl",
  "primary",
  "accent",
  "phone",
  "email",
  "footer",
] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function usedSlotNames(html: string): Set<string> {
  const names = new Set<string>();
  for (const m of html.matchAll(SLOT_RE)) if (m[1]) names.add(m[1]);
  for (const m of html.matchAll(ROWS_RE)) if (m[1]) names.add(m[1]);
  return names;
}

export function validateTemplate(
  input: unknown,
): { ok: true; template: Template } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["template must be an object"] };
  if (typeof input.id !== "string" || !ID_RE.test(input.id))
    errors.push("id must be a kebab-case slug");
  if (typeof input.name !== "string" || !input.name.trim()) errors.push("name is required");
  if (input.kind !== "pdf" && input.kind !== "message") errors.push("kind must be pdf or message");
  if (typeof input.html !== "string" || !input.html.trim()) errors.push("html is required");
  if (typeof input.updatedAt !== "number") errors.push("updatedAt must be a number");
  const declared = new Map<string, TemplateSlot>();
  if (!Array.isArray(input.slots)) errors.push("slots must be an array");
  else {
    input.slots.forEach((slot, idx) => {
      if (!isRecord(slot) || typeof slot.name !== "string" || !NAME_RE.test(slot.name)) {
        errors.push(`slots[${idx}]: name must match ${NAME_RE.source}`);
        return;
      }
      if (slot.kind !== "text" && slot.kind !== "rows" && slot.kind !== "prose")
        errors.push(`slot "${slot.name}": kind must be text, rows or prose`);
      if (typeof slot.description !== "string")
        errors.push(`slot "${slot.name}": description is required`);
      if (
        slot.kind === "rows" &&
        (!Array.isArray(slot.columns) ||
          slot.columns.length === 0 ||
          slot.columns.some((c) => typeof c !== "string" || !NAME_RE.test(c)))
      )
        errors.push(`slot "${slot.name}": rows slots need at least one column`);
      if (declared.has(slot.name)) errors.push(`slot "${slot.name}" is declared twice`);
      // SAFETY: every field of slot was checked just above; a failing check already pushed an error.
      declared.set(slot.name, slot as unknown as TemplateSlot);
    });
  }
  if (typeof input.html === "string") {
    const used = usedSlotNames(input.html);
    for (const name of used)
      if (!declared.has(name)) errors.push(`html uses undeclared slot "${name}"`);
    for (const name of declared.keys())
      if (!used.has(name)) errors.push(`slot "${name}" is declared but not used in html`);
  }
  // SAFETY: every Template field was validated above; errors.length === 0 means the shape holds.
  return errors.length
    ? { ok: false, errors }
    : { ok: true, template: input as unknown as Template };
}

export function validateBrand(
  input: unknown,
): { ok: true; brand: Brand } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["brand must be an object"] };
  if (typeof input.name !== "string" || !input.name.trim()) errors.push("name is required");
  for (const field of BRAND_FIELDS) {
    if (field === "name") continue;
    if (input[field] !== undefined && typeof input[field] !== "string")
      errors.push(`${field} must be a string`);
  }
  if (
    typeof input.logoDataUrl === "string" &&
    input.logoDataUrl &&
    !input.logoDataUrl.startsWith("data:image/")
  )
    errors.push("logoDataUrl must be a data:image/... URL");
  if (typeof input.updatedAt !== "number") errors.push("updatedAt must be a number");
  // SAFETY: fields validated above.
  return errors.length ? { ok: false, errors } : { ok: true, brand: input as unknown as Brand };
}

/** Deterministic substitution: no logic, no partial output. Every declared slot must be present
 *  (text/prose: non-empty string; rows: array of objects) or the render reports it as missing. */
export function renderTemplate(
  template: Template,
  data: Record<string, unknown>,
  brand?: Brand,
): { ok: true; output: string } | { ok: false; missing: string[] } {
  const esc = template.kind === "pdf" ? escapeHtml : (s: string) => s;
  const missing: string[] = [];
  const text = new Map<string, string>();
  const rows = new Map<string, Array<Record<string, unknown>>>();
  for (const slot of template.slots) {
    const value = data[slot.name];
    if (slot.kind === "rows") {
      if (Array.isArray(value) && value.every(isRecord)) rows.set(slot.name, value);
      else missing.push(slot.name);
    } else if (typeof value === "string" && value.trim()) text.set(slot.name, value);
    else if (typeof value === "number") text.set(slot.name, String(value));
    else missing.push(slot.name);
  }
  if (missing.length) return { ok: false, missing };
  let output = template.html.replaceAll(ROWS_RE, (_whole, name: string, body: string) =>
    (rows.get(name) ?? [])
      .map((row) => body.replaceAll(COL_RE, (_c, col: string) => esc(stringifyCell(row[col]))))
      .join(""),
  );
  output = output.replaceAll(SLOT_RE, (_whole, name: string) => esc(text.get(name) ?? ""));
  output = output.replaceAll(BRAND_RE, (_whole, field: (typeof BRAND_FIELDS)[number]) =>
    field === "logoDataUrl" ? (brand?.logoDataUrl ?? "") : esc(brand?.[field] ?? ""),
  );
  return { ok: true, output };
}

function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : JSON.stringify(value);
}

/** `[name]` for text/prose slots and one `[column]` row for rows slots — enough for a preview. */
export function placeholderData(template: Template): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const slot of template.slots) {
    data[slot.name] =
      slot.kind === "rows"
        ? [Object.fromEntries((slot.columns ?? []).map((c) => [c, `[${c}]`]))]
        : `[${slot.name}]`;
  }
  return data;
}
```

- [ ] **Step 4: Run tests → pass.** Gates. Commit: `feat(duties): template model and deterministic renderer`.

---

### Task 3: Store — templates, brand, settings, run files

**Files:**

- Modify: `extensions/duties/src/store.ts`
- Create: `extensions/duties/src/files.ts`
- Test: `extensions/duties/src/store.test.ts`, `extensions/duties/src/files.test.ts`

**Interfaces:**

- Produces (store):
  ```ts
  export type DutiesSettings = { owner?: { channel: string; target: string }; lastMailDispatchAt?: number; lastMailDispatchDutyId?: string };
  // DutyStores gains: templates: Keyed<Template>; brands: Keyed<Brand>; settings: Keyed<DutiesSettings>
  listTemplates(): Promise<Template[]>; getTemplate(id): Promise<Template | undefined>; saveTemplate(t): Promise<void>; deleteTemplate(id): Promise<boolean>;
  getBrand(): Promise<Brand | undefined>; saveBrand(b): Promise<void>;
  getSettings(): Promise<DutiesSettings>; updateSettings(patch: Partial<DutiesSettings>): Promise<DutiesSettings>;
  appendRunFile(id: string, file: RunFile): Promise<DutyRun | undefined>;
  ```
- Produces (files):

  ```ts
  export function createRunFiles(rootDir: string): {
    runDir(runId: string): Promise<string>;
    previewDir(): Promise<string>;
    cleanup(olderThanMs: number, now?: number): Promise<number>;
  };
  ```

  `rootDir` = `path.join(api.runtime.state.resolveStateDir(), "plugins", "duties", "files")`.

- [ ] **Step 1: Failing tests**

`store.test.ts` (extend the existing fake keyed-store helper the file already has):

```ts
it("stores templates, one brand, settings, and appends run files atomically", async () => {
  const store = makeStore(); // existing helper building DutyStore over in-memory Keyed<T>s — add templates/brands/settings maps
  await store.saveTemplate({
    id: "t",
    name: "T",
    kind: "pdf",
    html: "{{slot:a}}",
    slots: [{ name: "a", kind: "text", description: "" }],
    updatedAt: 1,
  });
  expect((await store.listTemplates()).map((t) => t.id)).toEqual(["t"]);
  await store.saveBrand({ name: "Amigos", updatedAt: 1 });
  expect((await store.getBrand())?.name).toBe("Amigos");
  expect(await store.getSettings()).toEqual({});
  await store.updateSettings({ owner: { channel: "telegram", target: "123" } });
  await store.updateSettings({ lastMailDispatchAt: 5 });
  expect(await store.getSettings()).toEqual({
    owner: { channel: "telegram", target: "123" },
    lastMailDispatchAt: 5,
  });
  await store.createRun(run("r1"));
  await store.appendRunFile("r1", {
    stepId: "t1",
    name: "a.pdf",
    path: "/x/a.pdf",
    bytes: 10,
    contentType: "application/pdf",
  });
  expect((await store.getRun("r1"))?.files).toHaveLength(1);
});
```

`files.test.ts`:

```ts
import { mkdtemp, writeFile, utimes, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRunFiles } from "./files.js";

describe("createRunFiles", () => {
  it("creates per-run dirs and removes runs older than the cutoff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "duties-files-"));
    const files = createRunFiles(root);
    const old = await files.runDir("old");
    const fresh = await files.runDir("fresh");
    await writeFile(path.join(old, "a.pdf"), "x");
    const past = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    await utimes(old, past, past);
    const removed = await files.cleanup(30 * 24 * 3600 * 1000);
    expect(removed).toBe(1);
    await expect(stat(old)).rejects.toThrow();
    await expect(stat(fresh)).resolves.toBeTruthy();
    expect(await files.previewDir()).toBe(path.join(root, "previews"));
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

`store.ts`: import `Template`/`Brand` from `./template.js`; add the three namespaces in `open()` (`templates`: maxEntries 1_000 reject-new; `brands`: 10; `settings`: 10), the methods above (`getSettings` returns `(await lookup("default")) ?? {}`; `updateSettings` uses `update` when present else lookup+register; `appendRunFile` mirrors `appendRunStep` on `files: [...(cur.files ?? []), file]`).

`files.ts`:

```ts
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

/** Rendered files live on disk (delivery needs a path); each run gets its own directory so a
 *  cleanup pass can drop whole runs by age without touching anything else. */
export function createRunFiles(rootDir: string) {
  const runsDir = path.join(rootDir, "runs");
  return {
    async runDir(runId: string): Promise<string> {
      const dir = path.join(runsDir, runId);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async previewDir(): Promise<string> {
      const dir = path.join(rootDir, "previews");
      await mkdir(dir, { recursive: true });
      return dir;
    },
    async cleanup(olderThanMs: number, now = Date.now()): Promise<number> {
      let removed = 0;
      let names: string[] = [];
      try {
        names = await readdir(runsDir);
      } catch {
        return 0;
      }
      for (const name of names) {
        const dir = path.join(runsDir, name);
        const info = await stat(dir).catch(() => undefined);
        if (!info?.isDirectory() || now - info.mtimeMs < olderThanMs) continue;
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
      return removed;
    },
  };
}
```

- [ ] **Step 4: Tests → pass. Gates. Commit:** `feat(duties): template, brand, settings namespaces and run file directories`.

---

### Task 4: Render adapter — one-time HTML route + browser `/pdf`

**Files:**

- Create: `extensions/duties/src/adapters/render.ts`
- Modify: `extensions/duties/src/adapters/browser.ts` (add `pdf`)
- Modify: `extensions/duties/src/runner.ts` (`BrowserAdapter.pdf` signature only)
- Test: `extensions/duties/src/adapters/render.test.ts`, extend `browser.test.ts`

**Interfaces:**

- Consumes: `POST /pdf { targetId }` → `{ ok, path }` (browser plugin, managed profile only); `api.registerHttpRoute({ path, match: "prefix", auth: "plugin", handler(req, res) })`; `resolveGatewayPort` from `openclaw/plugin-sdk/core` (check its parameters with `grep -n "export function resolveGatewayPort" -A6 src/config/paths.ts` and call it as the signature says, passing `api.config`).
- Produces:

  ```ts
  export type RenderServer = {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => boolean;
    publish(html: string): { url: string; token: string };
  };
  export function createRenderServer(params: {
    baseUrl: string;
    ttlMs?: number;
    now?: () => number;
  }): RenderServer; // path "/plugins/duties/render/"
  export type RenderAdapter = { toPdf(html: string, destPath: string): Promise<{ bytes: number }> };
  export function createRenderAdapter(params: {
    server: RenderServer;
    browser: Pick<BrowserAdapter, "open" | "pdf" | "close">;
    timeoutMs?: number;
  }): RenderAdapter;
  // BrowserAdapter gains: pdf(targetId: string): Promise<string>  // absolute path the browser plugin wrote
  ```

- [ ] **Step 1: Failing tests**

`render.test.ts`:

```ts
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
});
```

`browser.test.ts` addition:

```ts
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
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

`browser.ts` — add to the adapter object (single-attempt, it is not a read):

```ts
    async pdf(targetId) {
      const r = await call<{ path?: string }>("POST", "/pdf", { body: { targetId }, timeoutMs: 60_000 });
      if (typeof r.path !== "string" || !r.path) throw new Error("browser did not return a pdf path");
      return r.path;
    },
```

and `pdf(targetId: string): Promise<string>;` on `BrowserAdapter` in `runner.ts` (update the runner test's `fakeDeps` with `pdf: async () => "/tmp/fake.pdf"`).

`render.ts`:

```ts
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
```

- [ ] **Step 4: Tests → pass. Gates. Commit:** `feat(duties): render adapter — one-time html route and browser pdf`.

---

### Task 5: Deliver adapter

**Files:**

- Create: `extensions/duties/src/adapters/deliver.ts`
- Test: `extensions/duties/src/adapters/deliver.test.ts`

**Interfaces:**

- Consumes: `sendDurableMessageBatch({ cfg, channel, to, accountId?, payloads: [{ text?, mediaUrls? }] })` from `openclaw/plugin-sdk/channel-outbound` (result is a union on `status`: `sent | suppressed | partial_failed | failed`); `getSessionEntry({ agentId, sessionKey })` + `deliveryContextFromSession(entry)` → `{ channel?, to?, accountId? } | undefined` from `openclaw/plugin-sdk/session-store-runtime`.
- Produces:

  ```ts
  export type DeliverRoute = { channel: string; to: string; accountId?: string };
  export type RouteResolver = (
    to: string,
    channel: string | undefined,
    origin: RunOrigin | undefined,
  ) => Promise<DeliverRoute>;
  export function createRouteResolver(params: {
    ownerTarget: () => Promise<{ channel: string; target: string } | undefined>;
    sessionRoute: (origin: RunOrigin) => DeliverRoute | undefined;
  }): RouteResolver;
  export function sessionRouteFromStore(origin: RunOrigin): DeliverRoute | undefined; // wraps getSessionEntry + deliveryContextFromSession
  export type DeliverAdapter = {
    send(params: {
      route: DeliverRoute;
      text?: string;
      files?: string[];
    }): Promise<{ messageIds: string[] }>;
  };
  export function createDeliverAdapter(params: {
    cfg: OpenClawConfig;
    sendBatch?: typeof sendDurableMessageBatch;
  }): DeliverAdapter;
  export function maskTarget(to: string): string; // "+91••••1234" for phone-like, unchanged otherwise
  ```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createDeliverAdapter, createRouteResolver, maskTarget } from "./deliver.js";

describe("createRouteResolver", () => {
  const owner = { channel: "telegram", target: "111" };
  it("routes trigger to the chat origin, and falls back to owner when there was no chat", async () => {
    const resolve = createRouteResolver({
      ownerTarget: async () => owner,
      sessionRoute: (o) =>
        o.sessionKey === "agent:main:telegram:222" ? { channel: "telegram", to: "222" } : undefined,
    });
    expect(
      await resolve("trigger", undefined, { kind: "chat", sessionKey: "agent:main:telegram:222" }),
    ).toEqual({ channel: "telegram", to: "222" });
    expect(
      await resolve("trigger", undefined, { kind: "mail", sessionKey: "hook:gmail:1" }),
    ).toEqual({ channel: "telegram", to: "111" });
    expect(await resolve("trigger", undefined, undefined)).toEqual({
      channel: "telegram",
      to: "111",
    });
    expect(await resolve("+919999", "whatsapp", undefined)).toEqual({
      channel: "whatsapp",
      to: "+919999",
    });
  });
  it("fails loudly when no owner target is configured", async () => {
    const resolve = createRouteResolver({
      ownerTarget: async () => undefined,
      sessionRoute: () => undefined,
    });
    await expect(resolve("owner", undefined, undefined)).rejects.toThrow(
      /no owner target configured — set it on the Duties page/u,
    );
  });
});

describe("createDeliverAdapter", () => {
  it("sends text and files through the durable batch and surfaces a failed status", async () => {
    const sendBatch = vi.fn(async () => ({
      status: "sent" as const,
      results: [{ messageId: "m1" }],
      receipt: {},
    }));
    // SAFETY: the adapter only forwards cfg; the stub never inspects it.
    const cfg = {} as unknown as import("openclaw/plugin-sdk/core").OpenClawConfig;
    // SAFETY: the stub returns the subset of DurableMessageBatchSendResult the adapter reads.
    const adapter = createDeliverAdapter({
      cfg,
      sendBatch:
        sendBatch as unknown as typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch,
    });
    const r = await adapter.send({
      route: { channel: "telegram", to: "222" },
      text: "hi",
      files: ["/x/a.pdf"],
    });
    expect(r.messageIds).toEqual(["m1"]);
    expect(sendBatch.mock.calls[0]?.[0]).toMatchObject({
      channel: "telegram",
      to: "222",
      payloads: [{ text: "hi", mediaUrls: ["/x/a.pdf"] }],
    });
    const failing = vi.fn(async () => ({
      status: "failed" as const,
      error: new Error("channel down"),
    }));
    // SAFETY: as above.
    const bad = createDeliverAdapter({
      cfg,
      sendBatch:
        failing as unknown as typeof import("openclaw/plugin-sdk/channel-outbound").sendDurableMessageBatch,
    });
    await expect(
      bad.send({ route: { channel: "telegram", to: "222" }, text: "hi" }),
    ).rejects.toThrow(/channel down/u);
  });
  it("masks phone-like targets", () => {
    expect(maskTarget("+919876543210")).toBe("+91••••3210");
    expect(maskTarget("123456789")).toBe("123456789");
    expect(maskTarget("@someone")).toBe("@someone");
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement `deliver.ts`**

```ts
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  deliveryContextFromSession,
  getSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { RunOrigin } from "../store.js";

export type DeliverRoute = { channel: string; to: string; accountId?: string };
export type RouteResolver = (
  to: string,
  channel: string | undefined,
  origin: RunOrigin | undefined,
) => Promise<DeliverRoute>;

export const NO_OWNER_TARGET = "no owner target configured — set it on the Duties page";

/** "trigger" → the chat the run came from, else the owner; "owner" → the owner target; anything
 *  else is an explicit channel target (validateDuty already required `channel` for it). */
export function createRouteResolver(params: {
  ownerTarget: () => Promise<{ channel: string; target: string } | undefined>;
  sessionRoute: (origin: RunOrigin) => DeliverRoute | undefined;
}): RouteResolver {
  const owner = async (): Promise<DeliverRoute> => {
    const target = await params.ownerTarget();
    if (!target) throw new Error(NO_OWNER_TARGET);
    return { channel: target.channel, to: target.target };
  };
  return async (to, channel, origin) => {
    if (to === "owner") return owner();
    if (to === "trigger") {
      const route = origin?.kind === "chat" ? params.sessionRoute(origin) : undefined;
      return route ?? owner();
    }
    if (!channel) throw new Error(`deliver to "${to}" needs a channel`);
    return { channel, to };
  };
}

/** Looks up the delivery route of the session that called `duty_run`. Real sessions only — the
 *  runner receives an injectable `sessionRoute` so tests never touch the session store. */
export function sessionRouteFromStore(origin: RunOrigin): DeliverRoute | undefined {
  if (!origin.sessionKey) return undefined;
  const entry = getSessionEntry({
    agentId: origin.agentId ?? "main",
    sessionKey: origin.sessionKey,
  });
  const ctx = deliveryContextFromSession(entry);
  if (!ctx?.channel || !ctx.to) return undefined;
  return {
    channel: ctx.channel,
    to: ctx.to,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
  };
}

export type DeliverAdapter = {
  send(params: {
    route: DeliverRoute;
    text?: string;
    files?: string[];
  }): Promise<{ messageIds: string[] }>;
};

export function createDeliverAdapter(params: {
  cfg: OpenClawConfig;
  sendBatch?: typeof sendDurableMessageBatch;
}): DeliverAdapter {
  const sendBatch = params.sendBatch ?? sendDurableMessageBatch;
  return {
    async send({ route, text, files }) {
      const result = await sendBatch({
        cfg: params.cfg,
        channel: route.channel,
        to: route.to,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        payloads: [{ ...(text ? { text } : {}), ...(files?.length ? { mediaUrls: files } : {}) }],
      });
      if (result.status === "failed") {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      if (result.status === "suppressed") throw new Error(`delivery suppressed: ${result.reason}`);
      const ids = result.results.flatMap((r) =>
        typeof r.messageId === "string" ? [r.messageId] : [],
      );
      return { messageIds: ids };
    },
  };
}

export function maskTarget(to: string): string {
  return /^\+\d{8,}$/u.test(to) ? `${to.slice(0, 3)}••••${to.slice(-4)}` : to;
}
```

Adjust the exact field names (`results[].messageId`, `error`, `reason`, and whether `getSessionEntry`/`deliveryContextFromSession` are exported under those names) against `src/channels/message/send.ts:61-91` and `src/plugin-sdk/session-store-runtime.ts` — the implementer verifies with `grep` and keeps the test contract.

- [ ] **Step 4: Tests → pass. Gates (the `channel-outbound`/`session-store-runtime` imports must type-check under `pnpm tsgo:extensions`). Commit:** `feat(duties): deliver adapter and route resolution`.

---

### Task 6: Runner — `template` and `deliver` steps, origin, files

**Files:**

- Modify: `extensions/duties/src/runner.ts`
- Test: `extensions/duties/src/runner.test.ts`

**Interfaces:**

- Consumes: Tasks 1–5.
- Produces:

  ```ts
  // RunnerDeps gains:
  templates: { get(id: string): Promise<Template | undefined>; brand(): Promise<Brand | undefined> };
  render: RenderAdapter;
  deliver: DeliverAdapter;
  resolveRoute: RouteResolver;
  filesDir: string;                 // this run's directory (Task 3 `runDir(runId)`)
  onFile?: (file: RunFile) => void;
  // RunOptions gains: origin?: RunOrigin
  // RunOutcome gains: files: RunFile[]
  ```

- [ ] **Step 1: Failing tests** (extend `fakeDeps` with `templates`, `render`, `deliver`, `resolveRoute`, `filesDir`, `pdf`)

```ts
describe("template and deliver steps", () => {
  const flightTpl: Template = {
    id: "flight-options",
    name: "Flight options",
    kind: "pdf",
    updatedAt: 1,
    html: "<p>{{slot:route}}</p>{{#rows:flights}}<i>{{col:airline}}</i>{{/rows:flights}}<p>{{slot:notes}}</p>",
    slots: [
      { name: "route", kind: "text", description: "" },
      { name: "flights", kind: "rows", description: "", columns: ["airline"] },
      { name: "notes", kind: "prose", description: "" },
    ],
  };
  const dutySteps = (): DutyNode[] => [
    {
      id: "t1",
      kind: "template",
      label: "Render the options",
      params: {
        template: "flight-options",
        fill: {
          route: { from: "{{out:route}}" },
          flights: { from: "{{out:flights}}" },
          notes: { ai: "One line of advice" },
        },
      },
    },
    {
      id: "d1",
      kind: "deliver",
      label: "Send to the requester",
      params: { to: "trigger", text: "Options for {{out:route}}", files: ["{{file:t1}}"] },
    },
  ];

  it("fills mapped and ai slots, renders a pdf into the run dir, and delivers it to the origin route", async () => {
    const deps = fakeDeps({
      templates: {
        get: async () => flightTpl,
        brand: async () => ({ name: "Amigos", updatedAt: 1 }),
      },
      ai: {
        extract: async ({ schema }) =>
          Object.keys(schema.properties as Record<string, unknown>).includes("notes")
            ? { notes: "Book early" }
            : {},
      },
    });
    const outcome = await runDuty(duty(dutySteps()), deps, {
      inputs: {},
      origin: { kind: "chat", sessionKey: "agent:main:telegram:222" },
    });
    // `outputs` seeded by fakeDeps' earlier steps in the real test: set them explicitly
    expect(outcome.status).toBe("ok");
    expect(outcome.files).toEqual([
      expect.objectContaining({ stepId: "t1", contentType: "application/pdf" }),
    ]);
    expect(deps.calls).toContain("render <p>IXU → COK</p><i>IndiGo</i><p>Book early</p>");
    expect(deps.calls).toContain("deliver telegram:222 Options for IXU → COK [t1.pdf]");
    expect(outcome.steps.map((s) => s.summary)).toEqual([
      expect.stringContaining("t1.pdf"),
      "→ telegram:222",
    ]);
  });

  it("fails the template step naming the unfilled slot", async () => {
    const deps = fakeDeps({
      templates: { get: async () => flightTpl, brand: async () => undefined },
      ai: { extract: async () => ({}) },
    });
    const outcome = await runDuty(duty(dutySteps()), deps, { inputs: {} });
    expect(outcome.status).toBe("failed");
    expect(outcome.failedStep).toBe("t1");
    expect(outcome.report).toMatch(/slot "notes" could not be filled/u);
    expect(deps.calls.some((c) => c.startsWith("deliver"))).toBe(false);
  });

  it("a deliver with no chat origin and no owner target fails loudly", async () => {
    const deps = fakeDeps({
      resolveRoute: async () => {
        throw new Error("no owner target configured — set it on the Duties page");
      },
    });
    const outcome = await runDuty(
      duty([{ id: "d1", kind: "deliver", label: "Send", params: { to: "owner", text: "x" } }]),
      deps,
      { inputs: {} },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.report).toMatch(/no owner target configured/u);
  });

  it("a cancelled run never delivers", async () => {
    let cancelled = false;
    const deps = fakeDeps({ isCancelled: () => cancelled });
    const steps: DutyNode[] = [
      {
        id: "a1",
        kind: "ai",
        label: "Think",
        params: { instruction: "x", input: "y" },
        saveAs: "route",
      },
      { id: "d1", kind: "deliver", label: "Send", params: { to: "owner", text: "x" } },
    ];
    deps.ai = {
      extract: async () => {
        cancelled = true;
        return { route: "r" };
      },
    };
    const outcome = await runDuty(duty(steps), deps, { inputs: {} });
    expect(outcome.status).toBe("cancelled");
    expect(deps.calls.some((c) => c.startsWith("deliver"))).toBe(false);
  });
});
```

For the first test, seed outputs with two leading steps in `dutySteps()` (`ai` steps whose fake returns `{ route: "IXU → COK" }` and `{ flights: [{ airline: "IndiGo" }] }`) or set `fakeDeps` so `outputs` are provided — the implementer chooses; the assertions above hold either way. `fakeDeps` records `render <html>` (from a fake `render.toPdf` that writes `dest` with 4 bytes) and `deliver <channel>:<to> <text> [<basename list>]`; `resolveRoute` default returns `{ channel: "telegram", to: "222" }` when `origin?.kind === "chat"` else throws the owner error; `filesDir` is a fresh `mkdtempSync` dir.

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement in `runner.ts`**

Imports: `import type { Brand, Template } from "./template.js"; import { renderTemplate } from "./template.js"; import type { RenderAdapter } from "./adapters/render.js"; import type { DeliverAdapter, RouteResolver } from "./adapters/deliver.js"; import { maskTarget } from "./adapters/deliver.js"; import type { RunFile, RunOrigin } from "./store.js"; import path from "node:path";`

State: `const files: RunFile[] = [];` and extend `ctx()` with `file: (id) => files.find((f) => f.stepId === id)?.path`. Since `file` must not resolve inside browser/ai/ask params, build two cred-free resolvers: `resolve` (no `file`) as today and `resolveWithFiles` (adds `file`) used only by `template` and `deliver` params.

Step branches (before the exhaustiveness guard):

```ts
      } else if (step.kind === "template") {
        const template = await deps.templates.get(String(step.params.template));
        if (!template) throw new Error(`unknown template "${String(step.params.template)}"`);
        // SAFETY: validated by validateDuty as an object of { from } | { ai }.
        const fill = step.params.fill as Record<string, { from: string } | { ai: string }>;
        const data: Record<string, unknown> = {};
        const aiSlots: Array<{ name: string; instruction: string }> = [];
        for (const slot of template.slots) {
          const spec = fill[slot.name];
          if (!spec) continue;
          if ("from" in spec) {
            const raw = await resolve(spec.from);
            data[slot.name] = slot.kind === "rows" ? parseRows(raw) : raw;
          } else aiSlots.push({ name: slot.name, instruction: spec.ai });
        }
        if (aiSlots.length) {
          const properties = Object.fromEntries(aiSlots.map((s) => [s.name, { type: "string", description: s.instruction }]));
          const filled = await deps.ai.extract({
            instruction: "Write the following template slots from the run's data. Return every slot; never invent facts that are not in the data.",
            input: { data: { outputs, inputs: options.inputs }, slots: aiSlots },
            schema: { type: "object", properties, required: aiSlots.map((s) => s.name) },
          });
          for (const s of aiSlots) if (filled[s.name] !== undefined) data[s.name] = filled[s.name];
        }
        const rendered = renderTemplate(template, data, await deps.templates.brand());
        if (!rendered.ok) throw new Error(`slot "${rendered.missing[0]}" could not be filled`);
        const format = step.params.format ?? template.kind;
        if (format === "message") {
          save(step, rendered.output);
          summary = rendered.output.slice(0, 120);
        } else {
          const name = `${step.id}.pdf`;
          const dest = path.join(deps.filesDir, name);
          const { bytes } = await deps.render.toPdf(rendered.output, dest);
          const file: RunFile = { stepId: step.id, name, path: dest, bytes, contentType: "application/pdf" };
          files.push(file);
          deps.onFile?.(file);
          summary = `${name} (${bytes} bytes)`;
        }
      } else if (step.kind === "deliver") {
        const to = String(await resolveWithFiles(step.params.to));
        const channel = typeof step.params.channel === "string" ? step.params.channel : undefined;
        const route = await deps.resolveRoute(to, channel, options.origin);
        const text = typeof step.params.text === "string" ? await resolveWithFiles(step.params.text) : undefined;
        // SAFETY: validated by validateDuty as string[] when present.
        const filePlaceholders = (step.params.files as string[] | undefined) ?? [];
        const paths = await Promise.all(filePlaceholders.map((f) => resolveWithFiles(f)));
        await deps.deliver.send({ route, text, files: paths });
        summary = `→ ${route.channel}:${maskTarget(route.to)}`;
      } else {
```

with

```ts
function parseRows(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
```

(`resolve` returns the JSON-stringified array for an `{{out:flights}}` placeholder — `stringify` in `duty.ts` — so rows are parsed back.) Return `files` in `RunOutcome`. The evidence row for `template`/`deliver` uses the existing `record` call (`kind` = step.kind, no screenshot).

- [ ] **Step 4: Tests → pass (whole plugin). Gates. Commit:** `feat(duties): template and deliver steps in the runner`.

---

### Task 7: Run manager, `duty_run` origin + inputs, tools and gateway methods

**Files:**

- Modify: `extensions/duties/src/run-service.ts`, `extensions/duties/src/tools.ts`, `extensions/duties/src/gateway-methods.ts`, `extensions/duties/index.ts`, `extensions/duties/openclaw.plugin.json`
- Test: `run-service.test.ts`, `tools.test.ts`, `gateway-methods.test.ts`, `index.test.ts`

**Interfaces:**

- Consumes: `api.registerTool(factory, { name })` where factory is `(ctx: OpenClawPluginToolContext) => AnyAgentTool | null` (verify in `src/plugins/tool-types.ts` / `plugin-api.types.ts` — Part 1 passed static tools, which `registerTool` also accepts).
- Produces:
  - `RunManager.start(p)` gains `origin?: RunOrigin`; `deps: (duty, run) => RunnerDeps` (run id needed for `filesDir`); `onFile` wired to `store.appendRunFile`; `finish` writes `files`.
  - Status lines: `RunManager` accepts `notify?: (origin: RunOrigin, text: string) => Promise<void>`; on `running` → `Running <duty.name>…`, on terminal → `Done — <report|ok>` / `Failed at <step>: <report>` / `Blocked — <report>`, only when `origin.kind === "chat"`; best-effort, never throws.
  - Tools: `duty_run` (factory; validates inputs with `validateRunInputs`, records origin `{ kind, sessionKey, agentId, channel: messageChannel, accountId: agentAccountId }` where `kind = agentId === "duties-mail" ? "mail" : messageChannel ? "chat" : "manual"`; when kind is `mail`, `store.updateSettings({ lastMailDispatchAt: Date.now(), lastMailDispatchDutyId: id })`), `template_list`, `template_get`, `template_set` (validateTemplate; returns errors verbatim), `template_preview { id, data? }` → `{ path }` rendered into `previewDir()` (placeholderData when `data` absent), `brand_get`, `brand_set`.
  - Gateway: `duties.template.list` (read), `duties.template.get {id}` (read), `duties.template.delete {id}` (admin), `duties.template.preview {id, data?}` (read) → `{ contentType: "application/pdf", base64 }` (renders like the tool then reads the file), `duties.brand.get` (read), `duties.brand.set {brand}` (write), `duties.settings.get` (read; never returns `lastMailDispatch*` masked — they are not secrets), `duties.settings.set {owner}` (admin; validates `channel`/`target` non-empty strings), `duties.run.file {runId, stepId}` (read) → `{ name, contentType, base64 }`, `duties.mail.status` (read) → `{ hooksEnabled, gmailAccountSet, mappingPresent, agentPresent, lastDispatchAt?, lastDispatchDutyId? }` computed from `api.config` (`hooks.enabled`, `hooks.gmail.account`, `hooks.mappings[].agentId === "duties-mail"`, `agents.entries["duties-mail"]`) and settings.
  - `index.ts`: `api.registerHttpRoute({ path: RENDER_ROUTE_PATH, match: "prefix", auth: "plugin", handler: (req, res) => server.handler(req, res) })`; `baseUrl = \`http://127.0.0.1:${resolveGatewayPort(api.config)}\``; `filesRoot = path.join(api.runtime.state.resolveStateDir(), "plugins", "duties", "files")`; `runFiles.cleanup(30 days)` in the `duties:runs` service `start()` after `recoverOrphans`; `deliver = createDeliverAdapter({ cfg: api.config })`; `resolveRoute = createRouteResolver({ ownerTarget: async () => (await store.getSettings()).owner, sessionRoute: sessionRouteFromStore })`.
  - `openclaw.plugin.json` `contracts.tools` += `template_list, template_get, template_set, template_preview, brand_get, brand_set`.

- [ ] **Step 1: Failing tests** — add to each test file:
  - `run-service.test.ts`: start with `origin: { kind: "chat", sessionKey: "s" }` → stored run has `origin`; a fake runner deps `onFile` → `files` on the stored run; `notify` called with `Running …` then `Done — …` for a chat origin and never for `{ kind: "manual" }`.
  - `tools.test.ts`: `duty_run` factory given `ctx = { sessionKey: "agent:main:telegram:1", messageChannel: "telegram", agentId: "main" }` passes `origin.kind === "chat"` to `runs.start`; with `agentId: "duties-mail"` → `"mail"` and `updateSettings` called; a Duty declaring a `mail` input rejects `duty_run` without it (`{ ok: false, errors: ['input "mail" is required'] }`); `template_set` returns validation errors; `template_preview` returns a path under the preview dir (fake render writes it).
  - `gateway-methods.test.ts`: `duties.settings.set` requires admin scope and both fields; `duties.run.file` returns base64 of a temp file; `duties.mail.status` reflects a config with/without the mapping; `duties.template.preview` returns `contentType: "application/pdf"`.
  - `index.test.ts`: `register()` calls `registerHttpRoute` with `path: "/plugins/duties/render/"`, `auth: "plugin"`, `match: "prefix"`.

- [ ] **Step 2: Run → fail. Step 3: implement as specified above. Step 4: tests → pass. Gates. Commit:** `feat(duties): run origin and inputs, template/brand/settings surface, render route wiring`.

---

### Task 8: Mail dispatcher setup CLI and the skill

**Files:**

- Create: `extensions/duties/src/cli.ts`; Test: `extensions/duties/src/cli.test.ts`
- Modify: `extensions/duties/index.ts` (`api.registerCli`), `extensions/duties/skills/duties/SKILL.md`

**Interfaces:**

- Consumes: `api.registerCli(async ({ program }) => { … }, { descriptors: [{ name: "duties", description: "Duties setup", hasSubcommands: true }] })` (pattern: `extensions/oc-path/cli-registration.ts`); Commander `program.command("duties").command("setup-mail").requiredOption("--account <email>")`.
- Produces: `export function buildMailSetup(params: { account: string; gogPath?: string; config: { hooksEnabled: boolean; gmailAccount?: string; mappingPresent: boolean; agentPresent: boolean } }): { snippets: { agentEntry: string; hookMapping: string }; commands: string[]; missing: string[] }` — pure, tested; `registerDutiesCli(api)` prints `buildMailSetup` output.

- [ ] **Step 1: Failing test** — `buildMailSetup({ account: "ops@example.com", gogPath: undefined, config: { hooksEnabled: false, mappingPresent: false, agentPresent: false } })` returns `missing` containing `"gog CLI not found on PATH — install gogcli and run: gog auth add ops@example.com"`, `commands` containing `"openclaw webhooks gmail setup --account ops@example.com"` and `"openclaw approvals allowlist add --agent duties-mail <path-to-gog>"`, and `snippets.agentEntry` parsing as JSON with `tools.allow` = `["duty_list","duty_get","duty_run","message","exec"]`, `tools.profile: "minimal"`, `skills: ["duties"]`; `snippets.hookMapping` JSON has `agentId: "duties-mail"`, `match.path: "gmail"`, `forEach: "messages"`, `deliver: false`, and a `messageTemplate` containing `Message-Id: {{messages[0].id}}`.

- [ ] **Step 2: Run → fail. Step 3: implement.** The agent entry snippet:

```json
{
  "agents": {
    "entries": {
      "duties-mail": {
        "name": "Duties mail dispatcher",
        "skills": ["duties"],
        "tools": {
          "profile": "minimal",
          "allow": ["duty_list", "duty_get", "duty_run", "message", "exec"],
          "deny": ["browser", "group:fs", "group:web", "cron", "gateway", "nodes"]
        }
      }
    }
  }
}
```

The hook mapping snippet (message template lines: `From`, `Subject`, `Message-Id`, blank line, snippet, body, then the instruction line `Dispatch this mail to the matching Duty; see the duties skill.`):

```json
{
  "hooks": {
    "enabled": true,
    "mappings": [
      {
        "id": "duties-mail",
        "match": { "path": "gmail" },
        "action": "agent",
        "agentId": "duties-mail",
        "wakeMode": "now",
        "name": "Duties mail",
        "forEach": "messages",
        "deliver": false,
        "sessionKey": "hook:gmail:{{messages[0].id}}",
        "messageTemplate": "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\nMessage-Id: {{messages[0].id}}\n\n{{messages[0].snippet}}\n{{messages[0].body}}\n\nDispatch this mail to the matching Duty; see the duties skill."
      }
    ]
  }
}
```

`gogPath` is found with `which gog` (`execFile("which", ["gog"])`, best-effort) in the CLI action; the pure builder receives it. The CLI prints: what is already in place (from `duties.mail.status`-style config facts passed in), the two snippets, and the remaining commands, ending with `Then restart the Gateway.`

- [ ] **Step 4: SKILL.md** — add:
  - to the step vocabulary: `template` (`params.template`, `params.fill` per slot `{ from: "{{out:…}}" }` or `{ ai: "instruction" }`, optional `params.format`), `deliver` (`params.to: "trigger" | "owner" | target`, `params.channel` for explicit targets, `params.text`, `params.files: ["{{file:<templateStepId>}}"]`), placeholders `{{in:mail.body}}`, `{{in:mail.attachments.0.text}}`, `{{file:…}}` (deliver/template only);
  - **Templates** section: the loop from spec §4.4 (`template_list/get/set/preview`, `brand_get/set`, state how every slot is filled, send the preview with the `message` tool: `{ action: "send", message: "Preview", media: "<path>" }`), slot syntax with a 12-line example template;
  - **Triggers and dispatch** section: declare `triggers` with plain-words `match`; how to call `duty_run` with a `mail` input (`{ from, subject, body, messageId, attachments: [{ name, text }] }`) after reading the mail and its attachments (Gmail via `gog gmail …` through `exec`; a dropped file via the file's path), and for the `duties-mail` agent: pick exactly one matching active Duty, else message the owner (`message` tool) and stop;
  - the dispatcher never opens a browser or touches the Duty's steps.
- [ ] **Step 5: Gates. Commit:** `feat(duties): mail dispatcher setup command and skill sections`.

---

### Task 9: Control UI — triggers, files, Templates page, brand, settings, mail health

**Files:**

- Modify: `extensions/duties/browser/render.ts`, `extensions/duties/browser/index.ts`, `extensions/duties/browser/styles.css`, `extensions/duties/openclaw.plugin.json` (hash)
- Test: `extensions/duties/src/render.test.ts`

**Interfaces:**

- Consumes: gateway methods from Task 7.
- Produces:
  - `triggerChips`/`triggerRow`: `Mail: <match>`, `Chat: <match>`, `Manual`.
  - `renderRun`: a **Files** panel (`run.files` rows: name, size, `data-file="<stepId>"` button → `duties.run.file` → opens a `blob:` URL in a new tab / shows inline `<iframe>` for PDFs) and deliver evidence rows showing the `→ channel:target` summary.
  - `renderBoard`: header buttons `Templates`, `Logins`; a **Settings** strip: owner target form (`channel` select: telegram/whatsapp/signal/discord/slack — alphabetical; `target` text; `data-settings-save`) and **Mail trigger** health line (`hooksEnabled`, `mappingPresent`, `agentPresent`, last dispatch) with the instruction `Run: openclaw duties setup-mail --account <you@…>` when anything is missing.
  - `renderTemplates(view: { templates: Template[]; brand?: Brand }, opts)`: cards (name, kind, slots count, updated; `data-tpl-preview="<id>"` → `duties.template.preview` → inline `<iframe src="data:application/pdf;base64,…">`; `data-tpl-delete`) and the **Brand** form (name, logo file input → read as data URL on the client, primary/accent colour inputs, phone, email, footer; `data-brand-save`).
  - `index.ts`: views `templates`, `settings` handled like `logins`; loaders `loadTemplates`, `loadSettings`, `loadMailStatus`; handlers `saveSettings`, `saveBrand`, `previewTemplate`, `deleteTemplate`, `openFile`.

- [ ] **Step 1: Failing render tests** — trigger chips text for mail/chat/manual; run view lists `files` with a `data-file` control and shows a deliver row summary; templates view renders one card per template with `data-tpl-preview`, and the brand form with `data-brand-save`; board shows the settings strip with `data-settings-save` and the setup instruction when `mappingPresent` is false; escaping test: a template name containing `<script>` is escaped.
- [ ] **Step 2: Run → fail. Step 3: implement. Step 4: tests → pass; `pnpm tsgo:extensions`; rebuild the UI bundle (`cd extensions/duties && node --import ../../scripts/tsx.mjs ../../scripts/build-plugin-control-ui.mts`), commit the manifest hash with the change. Commit:** `feat(duties): templates page, brand and owner settings, run files in the Control UI`.

---

### Task 10: Live proof — mail → Duty → PDF → Telegram, and chat → PDF back

**Files:**

- Create: `docs/superpowers/plans/2026-09-14-duties-part2-proof.md` (`git add -f`)

Preconditions the controller provides in the dispatch: the proof Gateway (port 19001, state `~/.openclaw-duties`) with Telegram enabled for the owner's bot in that state dir, the owner's Telegram chat id as the owner target, and `gog` authorized for the Google Workspace account. Live Gateway on 18789 stays untouched.

- [ ] **Step 1:** Rebuild (`pnpm build`, foreground, timeout 600000) and start the proof Gateway (detached, as in the Part 1 proof).
- [ ] **Step 2: Setup** — run `node openclaw.mjs duties setup-mail --account <account>` with the proof env; apply its snippets to `~/.openclaw-duties/openclaw.json` (Task 8's output; record which were needed); run the printed `webhooks gmail setup`/approvals commands; restart the proof Gateway; `duties.mail.status` must report all four facts true.
- [ ] **Step 3: Author** through `node openclaw.mjs agent --agent krishna --session-key duties-p2 --json --message …` (≤ 8 turns): extend `amigos-search` (or draft `flight-options-by-mail`) with a `mail` input, an `ai` parse step (route/date/passengers from `{{in:mail.body}}` + `{{in:mail.attachments.0.text}}`), the existing search steps fed from the parsed outputs, a `browser.evaluate`/`read` step collecting the result rows into `flights`, a `template` step (`template_set` a "flight-options" template with brand; `template_preview` sent via `message`), a `deliver` step `to: "trigger"`, and triggers `mail: "travel requests"` + `chat: "a travel request or its PDF"`; `duty_save`.
- [ ] **Step 4: Mail proof** — forward the LIC-style test mail (the G703-1002 request) to the account → the dispatcher's isolated session runs `duty_run` → run `ok` → PDF arrives on the owner's Telegram (origin kind `mail` → owner). Record run id, step evidence, file row, deliver row.
- [ ] **Step 5: Chat proof** — send the same request (with the PDF attached) to the bot on Telegram: "run the flight options on this" → PDF returns in that chat (origin `chat`). Record.
- [ ] **Step 6:** Write the proof doc (commands redacted, run ids, evidence summaries, template JSON, what failed and what was fixed — any plugin bug fixed with a test and its own commit), stop only the 19001 Gateway, confirm 18789 listens. Commit: `docs(duties): live proof of Part 2 — mail and chat triggers, template pdf, deliver`.

---

## Self-review

**Spec coverage:** §3.1 triggers → T1; §3.2 dispatcher/hook → T8 (+ `duty_run` origin T7); §3.3 chat → T8 skill; §3.4 inputs/nested placeholders → T1, T7 validation; §3.5 origin → T7; §4.1 model → T2/T3; §4.2 step → T6 (+T4 render); §4.3 tools → T7; §4.4 authoring loop → T8; §5 deliver → T5/T6, owner target T3/T7/T9; §6 runner changes → T6/T7 (cleanup T7 start); §7 setup/health → T8/T7/T9; §8 UI → T9; §9 storage → T3; §10 errors → messages fixed in T2/T5/T6; §11 tests → each task + T10; §12 acceptance → T10.

**Placeholder scan:** none.

**Type consistency:** `RunOrigin`/`RunFile` defined in T1 (store.ts) and used by T5–T9; `RouteResolver` signature `(to, channel, origin)` identical in T5/T6; `RenderAdapter.toPdf(html, destPath)` identical in T4/T6; `Template`/`Brand` from `template.ts` everywhere; `BrowserAdapter.pdf` added in T4 before T6 uses it via `render`.
