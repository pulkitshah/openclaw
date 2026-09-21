import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserAdapter } from "./adapters/browser-contract.js";
import { maskTarget } from "./adapters/deliver.js";
import type { DeliverAdapter, RouteResolver } from "./adapters/deliver.js";
import type { RenderAdapter } from "./adapters/render.js";
import {
  type Check,
  type Cond,
  type Duty,
  type DutyNode,
  type Step,
  type Target,
  parseTeamRouteTarget,
  resolvePlaceholders,
} from "./duty.js";
import { safeFileName, uniqueFileName } from "./files.js";
import type { RunFile, RunOrigin, StepEvidence } from "./store.js";
import { renderTemplate } from "./template.js";
import type { Brand, Template } from "./template.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Coerces a Duty-authored param/output value to text without relying on Object's default
 *  `toString` ("[object Object]"): an object or array is JSON-encoded instead, so a
 *  misconfigured non-string value stays informative rather than silently misleading. */
function coerceParamText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Resolves every string leaf of a param, through arrays and plain objects rather than only at the
 * top level. An `ai` step's `params.input` is routinely an object or an array — that is how a
 * model is handed a named payload — and resolving only top-level strings shipped the literal text
 * `{{out:key}}` to the model: no error, no failed step, just an answer about the placeholder
 * instead of the value.
 *
 * Non-string leaves are returned untouched, so a schema's numbers and booleans survive. The
 * per-leaf resolver decides which placeholder kinds are legal, so nesting widens nothing: a
 * `{{cred:...}}` buried in an object still reaches the cred-free resolver and fails the step, and
 * `validateDuty` already walks nested params to reject it at authoring time
 * (`rejectCredStrings`/`forEachString`, duty.ts).
 */
async function resolveTree(
  value: unknown,
  resolveString: (text: string) => Promise<string>,
): Promise<unknown> {
  if (typeof value === "string") {
    return resolveString(value);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await resolveTree(item, resolveString));
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = await resolveTree(item, resolveString);
    }
    return out;
  }
  return value;
}

export type AiAdapter = {
  extract(params: {
    instruction: string;
    input: unknown;
    schema: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
};
type AskResult =
  | {
      status: "answered";
      answer: string;
      /** How the question reached the owner, when that is not the tappable card an `ask` is
       *  supposed to produce. Recorded in the step's evidence so a silent degradation is visible. */
      note?: string;
    }
  | { status: "timeout" | "cancelled" };
export type AskAdapter = {
  ask(params: {
    stepId: string;
    question: string;
    header: string;
    options: string[];
    timeoutMs?: number;
    /** The Team member id (already parsed off a `"team:<id>"` `params.target`) whose own session
     *  this question is raised in, instead of the owner's. Absent for the default, owner-targeted
     *  ask that existed before member-targeting did. */
    target?: string;
    /** Called with the created question's id as soon as it exists, so the run can park on it. */
    onAsked?: (questionId: string) => void;
  }): Promise<AskResult>;
};
/** The templates a `template` step renders, read through the store rather than handed in whole, so
 *  an edit on the Duties page is picked up by the next run without rebuilding the deps. */
type TemplateSource = {
  get(id: string): Promise<Template | undefined>;
  brand(): Promise<Brand | undefined>;
};
export type RunnerDeps = {
  browser: BrowserAdapter;
  ai: AiAdapter;
  ask: AskAdapter;
  cred: (key: string) => Promise<string>;
  templates: TemplateSource;
  render: RenderAdapter;
  deliver: DeliverAdapter;
  resolveRoute: RouteResolver;
  /** This run's own directory (`createRunFiles().runDir(runId)`); every document a `template` step
   *  produces is written here, so a cleanup pass can drop the whole run by age. */
  filesDir: string;
  /** Called as each document is produced, so a long run's files are recorded before it ends. */
  onFile?: (file: RunFile) => void;
  now?: () => number;
  onStep?: (evidence: StepEvidence) => void;
  /** Checked before every step and after every ask; a cancelled run halts instead of continuing
   *  to click, fill and submit until the browser work happens to finish. */
  isCancelled?: () => boolean;
  /** Called with the question the run is parked on, then with `undefined` once it is answered. */
  onWaiting?: (waitingOn: { questionId: string; stepId: string } | undefined) => void;
};
export type RunOptions = {
  inputs: Record<string, unknown>;
  toStepId?: string;
  keepOpen?: boolean;
  targetId?: string;
  /** Where the run came from; a `deliver` to "trigger" routes back to this chat. */
  origin?: RunOrigin;
};
export type RunOutcome = {
  status: "ok" | "failed" | "blocked" | "cancelled";
  steps: StepEvidence[];
  outputs: Record<string, unknown>;
  files: RunFile[];
  failedStep?: string;
  report?: string;
  targetId?: string;
};

// Both extend Error (rather than being plain classes) so every internal `throw` in this file
// throws a real Error, per the "only-throw-error" lint contract; `message` comes from `Error`
// itself, set via `super()`, so reading `.message` on a caught signal is unchanged.
class StopSignal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "StopSignal";
  }
}
class HaltSignal extends Error {
  constructor(
    readonly outcome: RunOutcome["status"],
    readonly stepId: string,
    message: string,
  ) {
    super(message);
    this.name = "HaltSignal";
  }
}

const MASK = "••••••";

/** Reserved key the model answers the document's file name under, alongside the template's own
 *  slots. A slot name matches `[A-Za-z0-9_-]+` (template.ts), which cannot contain `$`, so this
 *  key can never collide with a declared slot — an underscore prefix would not have been enough. */
const AI_FILENAME_KEY = "$filename";

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function runDuty(
  duty: Duty,
  deps: RunnerDeps,
  options: RunOptions,
): Promise<RunOutcome> {
  const now = deps.now ?? Date.now;
  const outputs: Record<string, unknown> = {};
  const files: RunFile[] = [];
  const evidence: StepEvidence[] = [];
  const secrets = new Set<string>();
  let targetId = options.targetId;
  /** The tab handed in by the previous stage (`keepOpen` → `targetId`). The FIRST `open` of the
   *  run resumes it instead of replaying the whole flow in a fresh tab; a later `open` in the
   *  same run means the author wants another tab, so it gets one. */
  let resumeTargetId = options.targetId;
  /** Every tab this run drove (the handed-in one included): all are closed at the end, except
   *  the current tab when `keepOpen` hands it to the next stage. */
  const ownedTabs = new Set<string>();
  if (targetId) {
    ownedTabs.add(targetId);
  }
  let reachedStop = false;
  const trackedCred = async (key: string): Promise<string> => {
    const value = await deps.cred(key);
    if (value.length >= 4) {
      secrets.add(value);
    }
    return value;
  };
  const redact = (text: string): string => {
    let result = text;
    for (const secret of secrets) {
      result = result.split(secret).join(MASK);
    }
    return result;
  };
  const ctx = () => ({ out: outputs, in: options.inputs });
  /** Cred-free: `resolvePlaceholders` throws `no credential stored for <key>` when a
   *  `{{cred:...}}` reaches it without a getter, so a placeholder authored anywhere but a
   *  `fill`/`select` value fails the step loudly instead of shipping the secret onward
   *  (`validateDuty` rejects those at authoring time; this is the run-time backstop). */
  const resolve = (value: unknown) =>
    resolveTree(value, (text) => resolvePlaceholders(text, ctx()));
  /** The one cred-capable resolver, used only for a browser `fill`/`select` value. */
  const resolveSecret = (value: string) =>
    resolvePlaceholders(value, { ...ctx(), cred: trackedCred });
  /** The one `file`-capable resolver, used only for `template` and `deliver` params. A
   *  `{{file:<stepId>}}` anywhere else reaches the cred-free `resolve` above, which has no `file`
   *  getter and so fails the step instead of putting a gateway-local path into a browser field, an
   *  ai prompt or a question the owner reads. */
  const resolveWithFiles = (value: unknown) =>
    resolveTree(value, (text) =>
      resolvePlaceholders(text, {
        ...ctx(),
        file: (stepId) => files.find((f) => f.stepId === stepId)?.path,
      }),
    );
  const requireTab = (): string => {
    if (!targetId) {
      throw new Error("no browser tab: add an open step first");
    }
    return targetId;
  };

  const record = (partial: Omit<StepEvidence, "durationMs"> & { startedAt: number }) => {
    const { startedAt, target, screenshotBlobId, ...rest } = partial;
    const item: StepEvidence = {
      ...rest,
      summary: redact(rest.summary),
      durationMs: now() - startedAt,
      // Conditional spreads so an absent target/screenshot never becomes an explicit
      // `undefined`-valued key: the host's gateway-event JSON validation
      // (`isPluginJsonValue`, `src/plugins/host-hook-json.ts`) rejects those.
      ...(target !== undefined ? { target } : {}),
      ...(screenshotBlobId !== undefined ? { screenshotBlobId } : {}),
    };
    evidence.push(item);
    deps.onStep?.(item);
  };

  const evalCond = async (cond: Cond): Promise<boolean> => {
    if ("visible" in cond) {
      return deps.browser.isVisible(requireTab(), cond.visible);
    }
    if ("equals" in cond) {
      return (await resolve(cond.equals[0])) === (await resolve(cond.equals[1]));
    }
    if ("url_matches" in cond) {
      return new RegExp(cond.url_matches, "iu").test(await deps.browser.url(requireTab()));
    }
    return new RegExp(cond.text_matches, "iu").test(await deps.browser.text(requireTab()));
  };

  const runCheck = async (check: Check): Promise<string | undefined> => {
    const tab = requireTab();
    if (check.visible && !(await deps.browser.isVisible(tab, check.visible))) {
      return `expected ${describeTarget(check.visible)} to be visible`;
    }
    if (
      check.url_matches &&
      !new RegExp(check.url_matches, "iu").test(await deps.browser.url(tab))
    ) {
      return `url did not match ${check.url_matches}`;
    }
    if (
      check.text_matches &&
      !new RegExp(check.text_matches, "iu").test(await deps.browser.text(tab))
    ) {
      return `page text did not match ${check.text_matches}`;
    }
    if (check.non_empty && !coerceParamText(outputs[check.non_empty]).trim()) {
      return `output ${check.non_empty} is empty`;
    }
    return undefined;
  };

  /** A `saveAs` key the step's result did not carry is left unset rather than written as an
   *  explicit `undefined`: the host's plugin state store rejects those (`isPluginJsonValue`,
   *  src/plugins/host-hook-json.ts), so one absent key failed the whole run at persistence — after
   *  every step had already run — with a message naming neither the step nor the key. An unset key
   *  resolves the same way an explicit `undefined` did wherever `{{out:key}}` reads it. */
  const save = (step: Step, value: unknown) => {
    if (!step.saveAs) {
      return;
    }
    if (Array.isArray(step.saveAs)) {
      const resultRecord = isRecord(value) ? value : undefined;
      for (const key of step.saveAs) {
        const saved = resultRecord?.[key];
        if (saved !== undefined) {
          outputs[key] = saved;
        }
      }
    } else if (value !== undefined) {
      outputs[step.saveAs] = value;
    }
  };

  const runStep = async (step: Step): Promise<void> => {
    if (deps.isCancelled?.()) {
      throw new HaltSignal("cancelled", step.id, "cancelled");
    }
    const startedAt = now();
    let summary: string;
    let usedCred: boolean;
    const budget = step.timeoutMs;
    try {
      if (step.kind === "browser") {
        const action = String(step.params.action);
        if (action === "open") {
          const url = String(await resolve(step.params.url));
          if (resumeTargetId) {
            await deps.browser.navigate(resumeTargetId, url, budget);
            targetId = resumeTargetId;
            resumeTargetId = undefined;
          } else {
            targetId = (await deps.browser.open(url, budget)).targetId;
            ownedTabs.add(targetId);
          }
          summary = url;
        } else if (action === "navigate") {
          const url = String(await resolve(step.params.url));
          await deps.browser.navigate(requireTab(), url, budget);
          summary = url;
        } else if (action === "click") {
          if (!step.target) {
            throw new Error("click needs a target");
          }
          await deps.browser.click(requireTab(), step.target, budget);
          summary = describeTarget(step.target);
        } else if (action === "fill" || action === "select") {
          if (!step.target) {
            throw new Error(`${action} needs a target`);
          }
          const raw = coerceParamText(step.params.value);
          usedCred = /\{\{cred:/u.test(raw);
          const value = await resolveSecret(raw);
          if (action === "fill") {
            await deps.browser.fill(requireTab(), step.target, value, budget);
          } else {
            await deps.browser.select(requireTab(), step.target, value, budget);
          }
          summary = `${describeTarget(step.target)} ← ${usedCred ? MASK : value}`;
        } else if (action === "press") {
          const key = String(await resolve(step.params.key));
          await deps.browser.press(requireTab(), key, budget);
          summary = key;
        } else if (action === "wait") {
          await deps.browser.waitFor(requireTab(), {
            target: step.target,
            text: typeof step.params.text === "string" ? step.params.text : undefined,
            url: typeof step.params.url === "string" ? step.params.url : undefined,
            timeoutMs: step.timeoutMs,
          });
          summary = "waited";
        } else if (action === "read") {
          const text = await deps.browser.text(requireTab(), step.target, budget);
          save(step, text);
          summary = text.slice(0, 120);
        } else if (action === "screenshot") {
          summary = "screenshot";
        } else {
          throw new Error(`unknown browser action "${action}"`);
        }
      } else if (step.kind === "browser.evaluate") {
        const fn = String(await resolve(step.params.fn));
        const result = await deps.browser.evaluate(requireTab(), fn, budget);
        save(step, result);
        summary = JSON.stringify(result)?.slice(0, 120) ?? "";
      } else if (step.kind === "ai") {
        // SAFETY: schema is authored duty config validated as an object elsewhere; a non-object falls back to the default shape.
        const schema = (step.params.schema as Record<string, unknown> | undefined) ?? {
          type: "object",
        };
        const result = await deps.ai.extract({
          instruction: String(await resolve(step.params.instruction)),
          input: await resolve(step.params.input),
          schema,
        });
        save(step, result);
        summary = Object.keys(result).join(", ");
      } else if (step.kind === "ask") {
        // SAFETY: askOptions is authored duty config; a missing/non-array value falls back to an empty list.
        const askOptions = (step.params.options as string[] | undefined) ?? [];
        const question = String(await resolve(step.params.question));
        // "owner" (or omitted) keeps asking in the owner's own session, unchanged; "team:<id>"
        // raises the question in that member's session instead — `validateDuty` already restricted
        // `params.target` to one of those two shapes.
        const targetRaw = typeof step.params.target === "string" ? step.params.target : undefined;
        const memberTarget = targetRaw ? (parseTeamRouteTarget(targetRaw) ?? undefined) : undefined;
        let result: Awaited<ReturnType<AskAdapter["ask"]>>;
        try {
          result = await deps.ask.ask({
            stepId: step.id,
            question,
            header: coerceParamText(step.params.header ?? step.label).slice(0, 12),
            options: askOptions,
            timeoutMs: step.timeoutMs,
            ...(memberTarget ? { target: memberTarget } : {}),
            onAsked: (questionId) => deps.onWaiting?.({ questionId, stepId: step.id }),
          });
        } finally {
          deps.onWaiting?.(undefined);
        }
        if (deps.isCancelled?.()) {
          throw new HaltSignal("cancelled", step.id, "cancelled");
        }
        if (result.status !== "answered") {
          throw new HaltSignal(
            result.status === "cancelled" ? "cancelled" : "blocked",
            step.id,
            `no answer to "${step.label}"`,
          );
        }
        save(step, result.answer);
        summary = result.note ? `${result.answer} (${result.note})` : result.answer;
      } else if (step.kind === "template") {
        const templateId = String(step.params.template);
        const template = await deps.templates.get(templateId);
        if (!template) {
          throw new Error(`unknown template "${templateId}"`);
        }
        // `renderTemplate` escapes by the template's own kind (a message body is left literal), so
        // a step's `format` may only restate that kind: printing a message template would serve its
        // unescaped text to the browser as HTML, and texting a pdf template would send raw markup.
        const format = typeof step.params.format === "string" ? step.params.format : template.kind;
        if (format !== template.kind) {
          throw new Error(
            `template "${template.id}" is a ${template.kind} template; format "${format}" is not allowed`,
          );
        }
        // SAFETY: validateDuty validated params.fill as an object of { from } | { ai }.
        const fill = step.params.fill as Record<string, { from: string } | { ai: string }>;
        let aiName: string | undefined;
        const data: Record<string, unknown> = {};
        const aiSlots: Array<{ name: string; instruction: string }> = [];
        // A fill key that names no declared slot used to be ignored, so a typo surfaced as a
        // DIFFERENT slot's missing-value error. The template is the authority on its own slots.
        const declared = new Set(template.slots.map((slot) => slot.name));
        const undeclared = Object.keys(fill).filter((name) => !declared.has(name));
        if (undeclared.length) {
          throw new Error(
            `template "${template.id}" has no slot(s) ${undeclared.join(", ")} (declared: ${[...declared].join(", ") || "none"})`,
          );
        }
        for (const slot of template.slots) {
          const spec = fill[slot.name];
          if (!spec) {
            continue;
          }
          if ("from" in spec) {
            const raw = String(await resolveWithFiles(spec.from));
            data[slot.name] = slot.kind === "rows" ? parseRows(raw) : raw;
          } else {
            // A rows slot needs an array of row objects; the ai call answers one string per slot,
            // so `{ ai }` on a rows slot can never succeed — and surfaced as the generic
            // `slot "x" could not be filled`, which names neither the cause nor the fix.
            if (slot.kind === "rows") {
              throw new Error(
                `slot "${slot.name}" is a rows slot: fill it with { from } from a step that produced the rows, not { ai }`,
              );
            }
            aiSlots.push({ name: slot.name, instruction: spec.ai });
          }
        }
        // A document that reaches someone's inbox needs a name they can read. An authored
        // `filename` wins; otherwise the model writes one in the SAME call that fills the prose
        // slots, so naming never costs a second round trip.
        const authoredName =
          typeof step.params.filename === "string" && step.params.filename.trim()
            ? String(await resolve(step.params.filename))
            : undefined;
        const wantsAiName = format === "pdf" && !authoredName;
        if (aiSlots.length || wantsAiName) {
          // One extract for the whole step: the model sees every slot it must write at once, so the
          // prose slots of one document cannot contradict each other.
          const properties: Record<string, unknown> = Object.fromEntries(
            aiSlots.map((s) => [s.name, { type: "string", description: s.instruction }]),
          );
          if (wantsAiName) {
            properties[AI_FILENAME_KEY] = {
              type: "string",
              description:
                "a short, specific file name for this document, no extension, from the data",
            };
          }
          // The slots are required — a template with an unfilled slot cannot render. The file
          // NAME is not: the naming chain below already falls back to "<template> <date>.pdf" and
          // then to the step id when the model offers nothing, so requiring it only converts a
          // cosmetic nicety into a failed run. Observed on a live desk: a 46-step run that had
          // signed in, emulated the client and collected 132 flights was thrown away by
          // "LLM JSON did not match schema: $filename: must have required property '$filename'".
          // It stays in `properties` so a model that can name the document still does.
          const required = aiSlots.map((s) => s.name);
          const filled = await deps.ai.extract({
            instruction:
              "Write the following template slots from the run's data. Return every slot; never invent facts that are not in the data.",
            input: { data: { outputs, inputs: options.inputs }, slots: aiSlots },
            schema: { type: "object", properties, required },
          });
          // Only declared slots are copied into the data, so the reserved name key can never be
          // mistaken for one.
          for (const s of aiSlots) {
            if (filled[s.name] !== undefined) {
              data[s.name] = filled[s.name];
            }
          }
          if (wantsAiName && typeof filled[AI_FILENAME_KEY] === "string") {
            aiName = filled[AI_FILENAME_KEY];
          }
        }
        const rendered = renderTemplate(template, data, await deps.templates.brand());
        if (!rendered.ok) {
          throw new Error(`slot "${rendered.missing[0]}" could not be filled`);
        }
        if (format === "message") {
          save(step, rendered.output);
          summary = rendered.output.slice(0, 120);
        } else {
          // Every candidate goes through `safeFileName`, which reduces it to one path segment, so
          // neither an authored placeholder nor a model-written name can place this run's document
          // outside its own directory. The step id is the last resort and is slug-checked already.
          const name = await uniqueFileName(
            deps.filesDir,
            safeFileName(authoredName ?? "", ".pdf") ??
              safeFileName(aiName ?? "", ".pdf") ??
              safeFileName(`${template.name} ${isoDate(now())}`, ".pdf") ??
              `${path.basename(step.id)}.pdf`,
          );
          const dest = path.join(deps.filesDir, name);
          const { bytes, previewPath } = await deps.render.toPdf(rendered.output, dest);
          const file: RunFile = {
            stepId: step.id,
            name,
            path: dest,
            bytes,
            contentType: "application/pdf",
            // Conditional so an absent preview never becomes an explicit `undefined`-valued key:
            // the plugin state store rejects those (`isPluginJsonValue`).
            ...(previewPath ? { previewPath } : {}),
          };
          files.push(file);
          deps.onFile?.(file);
          summary = `${name} (${bytes} bytes)`;
        }
      } else if (step.kind === "deliver") {
        const to = String(await resolveWithFiles(step.params.to));
        const channel = typeof step.params.channel === "string" ? step.params.channel : undefined;
        const routes = await deps.resolveRoute(to, channel, options.origin);
        const text =
          typeof step.params.text === "string"
            ? String(await resolveWithFiles(step.params.text))
            : undefined;
        // SAFETY: validateDuty validated params.files as an array of {{file:<stepId>}} strings when present.
        const filePlaceholders = (step.params.files as string[] | undefined) ?? [];
        const paths = await Promise.all(
          filePlaceholders.map(async (f) => String(await resolveWithFiles(f))),
        );
        // Defence in depth behind validateDuty's placeholder rule: only a path THIS run produced
        // may be attached, so a Duty saved before that rule (or one whose validation was somehow
        // bypassed) still cannot mail out an arbitrary readable file.
        const produced = new Set(files.map((f) => f.path));
        for (const candidate of paths) {
          if (!produced.has(candidate)) {
            throw new Error(
              `deliver can only attach a file this run produced; use {{file:<stepId>}} naming an earlier template step`,
            );
          }
        }
        // A team target with no channel fans out to every identity the member has (`resolveRoute`);
        // every other target still resolves to exactly one route. Each route is sent independently
        // — one channel's failure (a disconnected WhatsApp account, say) must not stop the message
        // from reaching the member on their other channels — but the step still fails loudly, per
        // the durable-batch `partial_failed` convention above, when every route failed: a Duty step
        // that silently delivered nowhere is exactly the silent failure this system refuses to have.
        const failures: string[] = [];
        const delivered: string[] = [];
        const messageIds: string[] = [];
        for (const route of routes) {
          const label = `${route.channel}:${maskTarget(route.to)}`;
          try {
            const sent = await deps.deliver.send({
              route,
              ...(text !== undefined ? { text } : {}),
              files: paths,
            });
            messageIds.push(...sent.messageIds);
            delivered.push(label);
          } catch (error) {
            failures.push(`${label}: ${errorMessage(error)}`);
          }
        }
        if (messageIds.length === 0 && failures.length > 0) {
          throw new Error(`delivery failed on every channel: ${failures.join("; ")}`);
        }
        summary =
          failures.length > 0
            ? `→ ${delivered.join(", ")} (failed: ${failures.join("; ")})`
            : `→ ${delivered.join(", ")}`;
      } else {
        // Exhaustiveness guard: a step kind outside the four handled above would otherwise be
        // recorded as a silent `ok` that performed no action at all.
        throw new Error(`unsupported step kind "${String(step.kind)}"`);
      }
      const retryNotes = deps.browser.drainRetryNotes?.() ?? [];
      if (retryNotes.length) {
        summary = summary ? `${summary} (${retryNotes.join("; ")})` : retryNotes.join("; ");
      }
      if (step.check) {
        const problem = await runCheck(step.check);
        if (problem) {
          throw new Error(problem);
        }
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
      // A cancelled run stopped on the owner's instruction, not on a step outcome: the run's own
      // `cancelled` status carries that, so no step evidence row is written for it.
      if (error instanceof HaltSignal && error.outcome === "cancelled") {
        throw error;
      }
      // Wider than the success-path gate on purpose: when an `ai` read or an `ask` fails, the page
      // the run was looking at IS the evidence. `template`/`deliver` failures are the exception —
      // they never look at a tab, so a screenshot there is just an unrelated page.
      const shot =
        step.kind !== "template" && step.kind !== "deliver" && targetId
          ? await deps.browser.screenshot(targetId).catch(() => undefined)
          : undefined;
      record({
        stepId: step.id,
        label: step.label,
        kind: step.kind,
        status: error instanceof HaltSignal && error.outcome === "blocked" ? "blocked" : "failed",
        summary: error instanceof HaltSignal ? error.message : errorMessage(error),
        startedAt,
        screenshotBlobId: shot,
      });
      throw error instanceof HaltSignal
        ? error
        : new HaltSignal("failed", step.id, errorMessage(error));
    }
    if (options.toStepId === step.id) {
      throw new StopSignal("");
    }
  };

  const walk = async (nodes: DutyNode[]): Promise<void> => {
    for (const node of nodes) {
      if (node.kind === "when") {
        const startedAt = now();
        let taken: boolean;
        try {
          taken = await evalCond(node.cond);
        } catch (error) {
          // A gate whose probe itself failed must name the gate in the run's evidence and report,
          // not fail the run with a bare message and no row to point at.
          const gateId = `when:${node.label}`;
          record({
            stepId: gateId,
            label: node.label,
            kind: "when",
            status: "failed",
            summary: errorMessage(error),
            startedAt,
          });
          throw new HaltSignal("failed", gateId, errorMessage(error));
        }
        await walk(taken ? node.then : (node.else ?? []));
        // A gate is a node the author can stage a run up to, exactly like a regular step: the gate
        // and its taken branch have now run, so `toStepId` stops here. Checking this only after a
        // regular step meant naming a gate ran the whole Duty instead, which on a booking flow is
        // the difference between reviewing a page and clicking past the point of no return.
        if (options.toStepId && options.toStepId === node.id) {
          throw new StopSignal("");
        }
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
      report = reachedStop ? redact(signal.reason) : undefined;
    } else if (signal instanceof HaltSignal) {
      status = signal.outcome;
      failedStep = signal.stepId;
      report = redact(signal.message);
    } else {
      status = "failed";
      report = redact(errorMessage(signal));
    }
  }
  const keptTab = options.keepOpen ? targetId : undefined;
  for (const tab of ownedTabs) {
    if (tab !== keptTab) {
      await deps.browser.close(tab).catch(() => {});
    }
  }
  return {
    status,
    steps: evidence,
    outputs,
    files,
    failedStep,
    report,
    targetId: options.keepOpen ? targetId : undefined,
  };
}

/** A rows fill reads `{{out:<name>}}`, and `resolvePlaceholders` JSON-encodes a non-string output,
 *  so the array arrives here as JSON text; anything else is handed to the template as-is and
 *  reported as a missing slot by `renderTemplate`. */
function parseRows(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function describeTarget(target: Target): string {
  if (target.role || target.name) {
    return `${target.role ?? ""}${target.name ? ` "${target.name}"` : ""}`.trim();
  }
  if (target.text) {
    return `text "${target.text}"`;
  }
  return target.css ?? "?";
}
