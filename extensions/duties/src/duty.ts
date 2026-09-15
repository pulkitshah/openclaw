import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type DutyStatus = "active" | "paused" | "building";
export const DUTY_STATUSES: readonly DutyStatus[] = ["active", "paused", "building"];
export type Target = { role?: string; name?: string; text?: string; css?: string };
export type Check = {
  visible?: Target;
  text_matches?: string;
  url_matches?: string;
  non_empty?: string;
};
type StepKind = "browser" | "browser.evaluate" | "ai" | "ask" | "template" | "deliver";
const STEP_KINDS: ReadonlySet<StepKind> = new Set([
  "browser",
  "browser.evaluate",
  "ai",
  "ask",
  "template",
  "deliver",
]);
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
export type Cond =
  | { visible: Target }
  | { equals: [string, string] }
  | { text_matches: string }
  | { url_matches: string };
type WhenNode = {
  kind: "when";
  /** Optional, unlike a step's: a gate is identified in evidence by its label, and `validateDuty`
   *  does not require one. Authors give gates ids anyway, and a gate that has one can be named as
   *  a `duty_run` `toStepId` to stage a run up to it. */
  id?: string;
  label: string;
  cond: Cond;
  then: DutyNode[];
  else?: DutyNode[];
};
type StopNode = { kind: "stop"; label: string; reason: string };
export type DutyNode = Step | WhenNode | StopNode;
export type DutyInput = {
  name: string;
  source: "ask" | "file" | "mail" | "trigger" | "cred" | "literal";
  prompt?: string;
  value?: string;
  /** Only meaningful for `mail`/`file`: default true — a run without it fails before step 1. */
  required?: boolean;
};
export type DutyTrigger =
  | { kind: "manual" }
  | { kind: "mail"; match: string }
  | { kind: "chat"; match: string };
const INPUT_SOURCES = ["ask", "file", "mail", "trigger", "cred", "literal"] as const;
const TRIGGER_KINDS = ["manual", "mail", "chat"] as const;
const DELIVER_ROUTES = ["trigger", "owner"] as const;
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
  /** A change to this ACTIVE Duty that is waiting for the owner, present only while
   *  `settings.requireApprovalForEdits` is on. The live Duty keeps running unchanged until the
   *  owner applies it. */
  pendingChange?: PendingDutyChange;
};

/** One edit to an active Duty, held until the owner applies or discards it. The candidate is
 *  stored already validated, so applying it is a write and never a re-validation that could fail
 *  after the owner said yes. */
export type PendingDutyChange = {
  id: string;
  duty: Duty;
  requestedAt: number;
  /** One line naming what applying it would change, for the message the owner reads. */
  summary: string;
};

/** Ids of the nodes an author can name: steps and the gates that carry an id. `stop` has none. */
function nodeIds(nodes: DutyNode[]): Map<string, string> {
  const byId = new Map<string, string>();
  const walk = (list: DutyNode[]): void => {
    for (const node of list) {
      if (node.kind === "when") {
        if (node.id) {
          byId.set(node.id, JSON.stringify(node.cond));
        }
        walk(node.then);
        walk(node.else ?? []);
        continue;
      }
      if (node.kind === "stop") {
        continue;
      }
      byId.set(
        node.id,
        JSON.stringify({ kind: node.kind, params: node.params, target: node.target }),
      );
    }
  };
  walk(nodes);
  return byId;
}

/**
 * One line describing what applying a pending change would do, in the terms the owner thinks in:
 * how many steps appear, disappear or behave differently, and whether the triggers or inputs move.
 * Never the step contents — a Duty's params can hold a customer's details.
 */
export function summarizeDutyChange(current: Duty, next: Duty): string {
  const before = nodeIds(current.steps);
  const after = nodeIds(next.steps);
  const added = [...after.keys()].filter((id) => !before.has(id)).length;
  const removed = [...before.keys()].filter((id) => !after.has(id)).length;
  const changed = [...after.entries()].filter(
    ([id, shape]) => before.has(id) && before.get(id) !== shape,
  ).length;
  const parts: string[] = [];
  if (added) {
    parts.push(`${added} step${added === 1 ? "" : "s"} added`);
  }
  if (removed) {
    parts.push(`${removed} step${removed === 1 ? "" : "s"} removed`);
  }
  if (changed) {
    parts.push(`${changed} step${changed === 1 ? "" : "s"} changed`);
  }
  if (JSON.stringify(current.triggers) !== JSON.stringify(next.triggers)) {
    parts.push("triggers changed");
  }
  if (JSON.stringify(current.inputs) !== JSON.stringify(next.inputs)) {
    parts.push("inputs changed");
  }
  if (current.name !== next.name || current.summary !== next.summary) {
    parts.push("name/summary changed");
  }
  return parts.length ? parts.join(", ") : "no visible change";
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/** A step id is not just a label: the runner joins `${step.id}.pdf` onto the run's files
 *  directory, so an id containing a path separator or `..` would write the rendered document
 *  outside the run's own directory — where the age sweep cannot see it and where
 *  `duties.run.file` would still read it back. Slug-only, like the duty id (`ID_RE`), the
 *  template id (`template.ts`) and the run id (`files.ts`). */
/** Defaults a header draft falls back to. They live with the Duty shape rather than with any one
 *  caller so the Gateway method and anything else drafting a Duty agree on what a new one looks
 *  like. */
export const DEFAULT_MACHINE = "gateway";
export const DEFAULT_REPORTS_TO = "owner";
export const DEFAULT_TRIGGERS: DutyTrigger[] = [{ kind: "manual" }];

const STEP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
/** A whole `deliver.params.files` entry: the placeholder and nothing else, with a step id in the
 *  same slug shape `STEP_ID_RE` allows. */
const FILE_PLACEHOLDER_RE = /^\{\{file:[a-z0-9][a-z0-9_-]{0,63}\}\}$/u;
const SELECTOR_LABEL_RE = /^[#.[]|^role=|^css=/u;

const TARGET_KEYS = ["role", "name", "text", "css"] as const;
const COND_KEYS = ["visible", "equals", "text_matches", "url_matches"] as const;
const CHECK_KEYS = ["visible", "text_matches", "url_matches", "non_empty"] as const;

function rejectUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  what: string,
  path: string,
  errors: string[],
): void {
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  if (unknown.length) {
    errors.push(`${path}: unknown ${what} key(s) ${unknown.join(", ")}`);
  }
}

function validateTarget(target: unknown, path: string, errors: string[]): void {
  if (!isRecord(target)) {
    errors.push(`${path}: target must be an object`);
    return;
  }
  rejectUnknownKeys(target, TARGET_KEYS, "target", path, errors);
  if (!TARGET_KEYS.some((k) => typeof target[k] === "string" && target[k])) {
    errors.push(`${path}: target needs at least one of role, name, text, css`);
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  errors: string[],
): value is string | undefined {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path}: must be a non-empty string`);
    return false;
  }
  return true;
}

function validateCond(cond: unknown, path: string, errors: string[]): void {
  if (!isRecord(cond)) {
    errors.push(`${path}: cond must be an object`);
    return;
  }
  const keys = Object.keys(cond);
  if (keys.length !== 1) {
    errors.push(`${path}: cond must have exactly one of ${COND_KEYS.join(", ")}`);
    return;
  }
  const key = keys[0];
  if (key === "visible") {
    validateTarget(cond.visible, `${path}.visible`, errors);
  } else if (key === "equals") {
    if (
      !Array.isArray(cond.equals) ||
      cond.equals.length !== 2 ||
      typeof cond.equals[0] !== "string" ||
      typeof cond.equals[1] !== "string"
    ) {
      errors.push(`${path}.equals: must be [string, string]`);
    }
  } else if (key === "text_matches" || key === "url_matches") {
    requireNonEmptyString(cond[key], `${path}.${key}`, errors);
  } else {
    errors.push(`${path}: unknown condition kind "${key}"`);
  }
  rejectCredStrings(cond, path, errors);
}

function validateCheck(check: unknown, path: string, errors: string[]): void {
  if (!isRecord(check)) {
    errors.push(`${path}: check must be an object`);
    return;
  }
  // `attribute` is taught nowhere and evaluated nowhere in Part 1; accepting it would let a gate
  // that never runs read as a pass, which is the worst failure mode a check can have.
  if (check.attribute !== undefined) {
    errors.push(`${path}.attribute: attribute checks arrive in Part 2`);
  }
  rejectUnknownKeys(check, [...CHECK_KEYS, "attribute"], "check", path, errors);
  if (check.visible !== undefined) {
    validateTarget(check.visible, `${path}.visible`, errors);
  }
  requireNonEmptyString(check.text_matches, `${path}.text_matches`, errors);
  requireNonEmptyString(check.url_matches, `${path}.url_matches`, errors);
  requireNonEmptyString(check.non_empty, `${path}.non_empty`, errors);
}

/** Walks every string reachable from `value` (objects and arrays included). */
function forEachString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      forEachString(item, visit);
    }
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      forEachString(item, visit);
    }
  }
}

const CRED_PLACEHOLDER_RULE =
  "{{cred:...}} is only allowed in a browser fill/select step's params.value";

/** A resolved credential must never reach the model, a channel, a URL, or a page script, so a
 *  cred placeholder is authorable in exactly one place: the value a `fill`/`select` types into a
 *  form field. Everywhere else it is rejected here rather than resolved at run time. */
function rejectCredStrings(value: unknown, path: string, errors: string[]): void {
  forEachString(value, (text) => {
    if (containsCredPlaceholder(text)) {
      errors.push(`${path}: ${CRED_PLACEHOLDER_RULE}`);
    }
  });
}

function validateStepParams(node: Record<string, unknown>, path: string, errors: string[]): void {
  if (!isRecord(node.params)) {
    return;
  }
  const params = node.params;
  const credValueAllowed =
    node.kind === "browser" && (params.action === "fill" || params.action === "select");
  for (const [key, value] of Object.entries(params)) {
    if (credValueAllowed && key === "value" && typeof value === "string") {
      continue;
    }
    rejectCredStrings(value, `${path}.params.${key}`, errors);
  }
  if (node.kind === "template") {
    validateTemplateParams(params, `${path}.params`, errors);
  }
  if (node.kind === "deliver") {
    validateDeliverParams(params, `${path}.params`, errors);
  }
  if (node.kind === "ask") {
    validateAskParams(params, `${path}.params`, errors);
  }
  if (node.kind === "ai") {
    validateAiParams(params, `${path}.params`, errors);
  }
}

/** The Gateway's own header cap (`QuestionHeaderSchema`, packages/gateway-protocol/src/schema/
 *  questions.ts:14). The runner truncates to it; an author should be told instead. */
const MAX_ASK_HEADER_CHARS = 12;

/**
 * An `ask` is Part 2's approval gate, so what it cannot do matters as much as what it can.
 *
 * A tappable card needs 2-4 distinct, non-blank option values — that is the host's own limit, and
 * the tap is mapped back by index. Below or above it, the message goes out as prose, and prose
 * cannot be answered: nothing routes a typed chat reply back to a question a plugin raised (the
 * in-process `ask_user` registry only serves the agent turn that opened the question, and a Duty
 * run has no such turn), so the reply reaches the agent as ordinary chat and the run waits out its
 * timeout. That is exactly what the live proof hit. So options are required, and required to be
 * usable.
 */
function validateAskParams(params: Record<string, unknown>, path: string, errors: string[]): void {
  if (typeof params.question !== "string" || !params.question.trim()) {
    errors.push(`${path}.question: must be a non-empty string`);
  }
  if (
    params.header !== undefined &&
    (typeof params.header !== "string" || params.header.length > MAX_ASK_HEADER_CHARS)
  ) {
    errors.push(`${path}.header: must be a string of at most ${MAX_ASK_HEADER_CHARS} characters`);
  }
  if (params.options === undefined) {
    errors.push(
      `${path}.options: an ask needs 2–4 distinct options — a typed reply does not answer a Duty's question, only a tapped choice does`,
    );
    return;
  }
  if (!Array.isArray(params.options) || params.options.some((o) => typeof o !== "string")) {
    errors.push(`${path}.options: must be an array of strings`);
    return;
  }
  const options = params.options.map((o) => String(o).trim()).filter(Boolean);
  if (
    options.length !== params.options.length ||
    options.length < 2 ||
    options.length > 4 ||
    new Set(options.map((o) => o.toLowerCase())).size !== options.length
  ) {
    errors.push(`${path}.options: ask options must be 2–4 distinct choices for a tappable card`);
  }
}

/** An `ai` step with no instruction sent the model the literal string "undefined"; a non-object
 *  schema reached `ai.extract` as one. */
function validateAiParams(params: Record<string, unknown>, path: string, errors: string[]): void {
  if (typeof params.instruction !== "string" || !params.instruction.trim()) {
    errors.push(`${path}.instruction: must be a non-empty string`);
  }
  if (params.schema !== undefined && !isRecord(params.schema)) {
    errors.push(`${path}.schema: must be an object`);
  }
}

function validateTemplateParams(
  params: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  if (typeof params.template !== "string" || !params.template.trim()) {
    errors.push(`${path}.template: must be a non-empty string`);
  }
  if (params.format !== undefined && params.format !== "pdf" && params.format !== "message") {
    errors.push(`${path}.format: must be pdf or message`);
  }
  // `{{cred:}}` inside it is already rejected by validateStepParams, which walks every param.
  if (
    params.filename !== undefined &&
    (typeof params.filename !== "string" || !params.filename.trim())
  ) {
    errors.push(`${path}.filename: must be a non-empty string`);
  }
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
    if (!okFrom && !okAi) {
      errors.push(`${path}.fill.${slot}: must be { from } or { ai }`);
    }
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
  if (explicit && (typeof params.channel !== "string" || !params.channel.trim())) {
    errors.push(`${path}.channel: required when to is not "trigger" or "owner"`);
  }
  if (params.text !== undefined && typeof params.text !== "string") {
    errors.push(`${path}.text: must be a string`);
  }
  if (params.files !== undefined) {
    if (!Array.isArray(params.files)) {
      errors.push(`${path}.files: must be an array of {{file:<stepId>}} strings`);
    } else {
      // Each entry must BE a placeholder, not merely contain one. Accepting any string let an
      // authored Duty name a path on disk — a config file, a keychain export, a log — and
      // `resolveWithFiles` passed it through verbatim into the attachment list.
      params.files.forEach((entry, index) => {
        if (typeof entry !== "string" || !FILE_PLACEHOLDER_RE.test(entry)) {
          errors.push(`${path}.files[${index}]: must be a {{file:<stepId>}} placeholder`);
        }
      });
    }
  }
  if (params.text === undefined && params.files === undefined) {
    errors.push(`${path}: deliver needs text and/or files`);
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
      if (!isRecord(node.cond)) {
        errors.push(`${p}: when needs a cond`);
      } else {
        validateCond(node.cond, `${p}.cond`, errors);
      }
      validateNodes(node.then, `${p}.then`, errors, seenIds);
      if (node.else !== undefined) {
        validateNodes(node.else, `${p}.else`, errors, seenIds);
      }
      return;
    }
    if (node.kind === "stop") {
      if (typeof node.reason !== "string" || !node.reason.trim()) {
        errors.push(`${p}: stop needs a reason`);
      } else {
        rejectCredStrings(node.reason, `${p}.reason`, errors);
      }
      return;
    }
    // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary node.kind be compared, and a non-StepKind value is reported as an error on the next line.
    if (!STEP_KINDS.has(node.kind as StepKind)) {
      errors.push(`${p}: unknown step kind "${String(node.kind)}"`);
      return;
    }
    if (typeof node.id !== "string" || !node.id) {
      errors.push(`${p}: step id is required`);
    } else if (!STEP_ID_RE.test(node.id)) {
      errors.push(`${p}: step id must be a slug (letters, digits, _ -)`);
    } else if (seenIds.has(node.id)) {
      errors.push(`${p}: duplicate step id "${node.id}"`);
    } else {
      seenIds.add(node.id);
    }
    if (!isRecord(node.params)) {
      errors.push(`${p}: params must be an object`);
    } else {
      validateStepParams(node, p, errors);
    }
    if (node.target !== undefined) {
      validateTarget(node.target, p, errors);
    }
    if (node.check !== undefined) {
      validateCheck(node.check, p, errors);
    }
  });
}

export function validateDuty(
  input: unknown,
): { ok: true; duty: Duty } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ["duty must be an object"] };
  }
  if (typeof input.id !== "string" || !ID_RE.test(input.id)) {
    errors.push("id must be a kebab-case slug");
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    errors.push("name is required");
  }
  if (typeof input.summary !== "string") {
    errors.push("summary is required");
  }
  // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary input.status be compared, and a non-DutyStatus value is reported as an error.
  if (!DUTY_STATUSES.includes(input.status as DutyStatus)) {
    errors.push(`status must be one of ${DUTY_STATUSES.join(", ")}`);
  }
  if (typeof input.machine !== "string" || !input.machine) {
    errors.push("machine is required");
  }
  if (typeof input.reportsTo !== "string" || !input.reportsTo) {
    errors.push("reportsTo is required");
  }
  if (!Array.isArray(input.inputs)) {
    errors.push("inputs must be an array");
  } else {
    input.inputs.forEach((inp, idx) => {
      if (!isRecord(inp)) {
        errors.push(`inputs[${idx}]: must be an object`);
        return;
      }
      if (typeof inp.name !== "string" || !inp.name.trim()) {
        errors.push(`inputs[${idx}].name: must be a non-empty string`);
      }
      // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary inp.source be compared, and a non-matching value is reported as an error.
      if (!INPUT_SOURCES.includes(inp.source as (typeof INPUT_SOURCES)[number])) {
        errors.push(`inputs[${idx}].source: must be one of ${INPUT_SOURCES.join(", ")}`);
      }
    });
  }
  if (!Array.isArray(input.triggers)) {
    errors.push("triggers must be an array");
  } else {
    if (input.triggers.length === 0) {
      errors.push("triggers must have at least one trigger");
    }
    input.triggers.forEach((trg, idx) => {
      if (!isRecord(trg)) {
        errors.push(`triggers[${idx}]: must be an object`);
        return;
      }
      // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary trg.kind be compared, and a non-matching value is reported as an error.
      if (!TRIGGER_KINDS.includes(trg.kind as (typeof TRIGGER_KINDS)[number])) {
        errors.push(`triggers[${idx}].kind: must be one of ${TRIGGER_KINDS.join(", ")}`);
      }
      if (
        (trg.kind === "mail" || trg.kind === "chat") &&
        (typeof trg.match !== "string" || !trg.match.trim())
      ) {
        errors.push(`triggers[${idx}].match: must be a non-empty string`);
      }
    });
  }
  if (typeof input.updatedAt !== "number") {
    errors.push("updatedAt must be a number");
  }
  validateNodes(input.steps, "steps", errors, new Set());
  if (errors.length) {
    return { ok: false, errors };
  }
  // Parses the validated record into a Duty field by field rather than reinterpreting the whole
  // blob: each assertion below is justified by the check just above it, and `exclusive`/
  // `pendingChange` — never validated — pass through exactly as before via the leading spread.
  return {
    ok: true,
    duty: {
      ...(input as { exclusive?: boolean; pendingChange?: PendingDutyChange }),
      // SAFETY: typeof/ID_RE-checked above.
      id: input.id as string,
      // SAFETY: typeof/non-empty-checked above.
      name: input.name as string,
      // SAFETY: typeof-checked above.
      summary: input.summary as string,
      // SAFETY: DUTY_STATUSES.includes()-checked above.
      status: input.status as DutyStatus,
      // SAFETY: typeof/non-empty-checked above.
      machine: input.machine as string,
      // SAFETY: typeof/non-empty-checked above.
      reportsTo: input.reportsTo as string,
      // SAFETY: Array.isArray() plus a per-entry name/source check above.
      inputs: input.inputs as DutyInput[],
      // SAFETY: validateNodes recursively confirmed every node above.
      steps: input.steps as DutyNode[],
      // SAFETY: Array.isArray() plus a per-entry kind/match check above.
      triggers: input.triggers as DutyTrigger[],
      // SAFETY: typeof-checked above.
      updatedAt: input.updatedAt as number,
    },
  };
}

/** Checks the inputs handed to a run against the Duty's declared `mail`/`file` inputs. Returns
 *  one message per problem; an empty array means the run may start. */
export function validateRunInputs(duty: Duty, inputs: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const input of duty.inputs) {
    if (input.source !== "mail" && input.source !== "file") {
      continue;
    }
    const value = inputs[input.name];
    if (value === undefined) {
      if (input.required !== false) {
        errors.push(`input "${input.name}" is required`);
      }
      continue;
    }
    if (!isRecord(value)) {
      errors.push(`input "${input.name}": must be an object`);
      continue;
    }
    const need = input.source === "mail" ? ["from", "subject", "body"] : ["name", "path"];
    for (const field of need) {
      if (typeof value[field] !== "string") {
        errors.push(`input "${input.name}": ${field} must be a string`);
      }
    }
  }
  return errors;
}

const PLACEHOLDER_RE = /\{\{(out|in|cred|file):([A-Za-z0-9_.-]+)\}\}/gu;

/** Own properties only: `{{out:constructor}}` and `{{in:__proto__}}` otherwise walked the
 *  prototype chain, and `stringify` then returned `JSON.stringify(fn) === undefined` against a
 *  `string` signature, so the substitution wrote the literal text `undefined` into a document, a
 *  message or a form field. */
function readPath(root: unknown, dotted: string): unknown {
  let cur: unknown = root;
  for (const segment of dotted.split(".")) {
    if (Array.isArray(cur)) {
      cur = cur[Number(segment)];
    } else if (isRecord(cur) && Object.hasOwn(cur, segment)) {
      cur = cur[segment];
    } else {
      return undefined;
    }
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
    if (!whole || !scope || !key) {
      continue;
    }
    let replacement = "";
    if (scope === "out") {
      replacement = stringify(readPath(ctx.out, key));
    } else if (scope === "in") {
      replacement = stringify(readPath(ctx.in, key));
    } else if (scope === "file") {
      const path = ctx.file?.(key);
      if (!path) {
        throw new Error(`no file from step "${key}"`);
      }
      replacement = path;
    } else {
      if (!ctx.cred) {
        throw new Error(`no credential stored for ${key}`);
      }
      replacement = await ctx.cred(key);
    }
    result = result.replaceAll(whole, () => replacement);
  }
  return result;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function containsCredPlaceholder(value: string): boolean {
  return /\{\{cred:[A-Za-z0-9_.-]+\}\}/u.test(value);
}
