import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

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

function validateTarget(target: unknown, path: string, errors: string[]): void {
  if (!isRecord(target)) {
    errors.push(`${path}: target must be an object`);
    return;
  }
  if (!["role", "name", "text", "css"].some((k) => typeof target[k] === "string" && target[k])) {
    errors.push(`${path}: target needs at least one of role, name, text, css`);
  }
}

function validateCond(cond: unknown, path: string, errors: string[]): void {
  if (!isRecord(cond)) {
    errors.push(`${path}: cond must be an object`);
    return;
  }
  const keys = Object.keys(cond);
  if (keys.length !== 1) {
    errors.push(`${path}: cond must have exactly one of visible, equals, text_matches`);
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
  } else if (key === "text_matches") {
    if (typeof cond.text_matches !== "string" || !cond.text_matches.trim()) {
      errors.push(`${path}.text_matches: must be a non-empty string`);
    }
  } else {
    errors.push(`${path}: unknown condition kind "${key}"`);
  }
}

function validateCheck(check: unknown, path: string, errors: string[]): void {
  if (!isRecord(check)) {
    errors.push(`${path}: check must be an object`);
    return;
  }
  if (check.visible !== undefined) validateTarget(check.visible, `${path}.visible`, errors);
  if (typeof check.text_matches !== "undefined") {
    if (typeof check.text_matches !== "string" || !check.text_matches.trim()) {
      errors.push(`${path}.text_matches: must be a non-empty string`);
    }
  }
  if (typeof check.url_matches !== "undefined") {
    if (typeof check.url_matches !== "string" || !check.url_matches.trim()) {
      errors.push(`${path}.url_matches: must be a non-empty string`);
    }
  }
  if (typeof check.non_empty !== "undefined") {
    if (typeof check.non_empty !== "string" || !check.non_empty.trim()) {
      errors.push(`${path}.non_empty: must be a non-empty string`);
    }
  }
  if (check.attribute !== undefined) {
    if (!isRecord(check.attribute)) {
      errors.push(`${path}.attribute: must be an object`);
    } else {
      if (check.attribute.target !== undefined)
        validateTarget(check.attribute.target, `${path}.attribute.target`, errors);
      if (typeof check.attribute.name !== "string" || !check.attribute.name.trim()) {
        errors.push(`${path}.attribute.name: must be a non-empty string`);
      }
    }
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
      else validateCond(node.cond, `${p}.cond`, errors);
      validateNodes(node.then, `${p}.then`, errors, seenIds);
      if (node.else !== undefined) validateNodes(node.else, `${p}.else`, errors, seenIds);
      return;
    }
    if (node.kind === "stop") {
      if (typeof node.reason !== "string" || !node.reason.trim())
        errors.push(`${p}: stop needs a reason`);
      return;
    }
    // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary node.kind be compared, and a non-StepKind value is reported as an error on the next line.
    if (!STEP_KINDS.includes(node.kind as StepKind)) {
      errors.push(`${p}: unknown step kind "${String(node.kind)}"`);
      return;
    }
    if (typeof node.id !== "string" || !node.id) errors.push(`${p}: step id is required`);
    else if (seenIds.has(node.id)) errors.push(`${p}: duplicate step id "${node.id}"`);
    else seenIds.add(node.id);
    if (!isRecord(node.params)) errors.push(`${p}: params must be an object`);
    if (node.target !== undefined) validateTarget(node.target, p, errors);
    if (node.check !== undefined) validateCheck(node.check, p, errors);
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
  // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary input.status be compared, and a non-DutyStatus value is reported as an error.
  if (!DUTY_STATUSES.includes(input.status as DutyStatus))
    errors.push(`status must be one of ${DUTY_STATUSES.join(", ")}`);
  if (typeof input.machine !== "string" || !input.machine) errors.push("machine is required");
  if (typeof input.reportsTo !== "string" || !input.reportsTo) errors.push("reportsTo is required");
  if (!Array.isArray(input.inputs)) errors.push("inputs must be an array");
  else {
    input.inputs.forEach((inp, idx) => {
      if (!isRecord(inp)) {
        errors.push(`inputs[${idx}]: must be an object`);
        return;
      }
      if (typeof inp.name !== "string" || !inp.name.trim())
        errors.push(`inputs[${idx}].name: must be a non-empty string`);
      const sources = ["ask", "file", "trigger", "cred", "literal"] as const;
      // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary inp.source be compared, and a non-matching value is reported as an error.
      if (!sources.includes(inp.source as (typeof sources)[number]))
        errors.push(`inputs[${idx}].source: must be one of ${sources.join(", ")}`);
    });
  }
  if (!Array.isArray(input.triggers)) errors.push("triggers must be an array");
  else {
    input.triggers.forEach((trg, idx) => {
      if (!isRecord(trg)) {
        errors.push(`triggers[${idx}]: must be an object`);
        return;
      }
      const kinds = ["manual", "webhook"] as const;
      // SAFETY: includes() is the actual runtime membership check; the cast only lets an arbitrary trg.kind be compared, and a non-matching value is reported as an error.
      if (!kinds.includes(trg.kind as (typeof kinds)[number]))
        errors.push(`triggers[${idx}].kind: must be one of ${kinds.join(", ")}`);
    });
  }
  if (typeof input.updatedAt !== "number") errors.push("updatedAt must be a number");
  validateNodes(input.steps, "steps", errors, new Set());
  // SAFETY: reaching here with errors.length === 0 means every Duty field was checked above (id, name, summary, status, machine, reportsTo, inputs, triggers, updatedAt, steps), so input structurally matches Duty.
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
    const whole = match[0];
    const scope = match[1];
    const key = match[2];
    if (!whole || !scope || !key) continue;
    let replacement = "";
    if (scope === "out") replacement = stringify(ctx.out[key]);
    else if (scope === "in") replacement = stringify(ctx.in[key]);
    else {
      if (!ctx.cred) throw new Error(`no credential stored for ${key}`);
      replacement = await ctx.cred(key);
    }
    result = result.replaceAll(whole, () => replacement);
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
