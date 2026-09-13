export type DutyStatus = "active" | "paused" | "building";
export const DUTY_STATUSES: readonly DutyStatus[] = ["active", "paused", "building"];
export type Target = { role?: string; name?: string; text?: string; css?: string };
export type Check = {
  visible?: Target; text_matches?: string; url_matches?: string; non_empty?: string;
  attribute?: { target: Target; name: string };
};
export type StepKind = "browser" | "browser.evaluate" | "ai" | "ask";
export const STEP_KINDS: readonly StepKind[] = ["browser", "browser.evaluate", "ai", "ask"];
export type Step = {
  id: string; kind: StepKind; label: string; params: Record<string, unknown>;
  target?: Target; check?: Check; saveAs?: string | string[]; timeoutMs?: number;
};
export type Cond = { visible: Target } | { equals: [string, string] } | { text_matches: string };
export type WhenNode = { kind: "when"; label: string; cond: Cond; then: DutyNode[]; else?: DutyNode[] };
export type StopNode = { kind: "stop"; label: string; reason: string };
export type DutyNode = Step | WhenNode | StopNode;
export type DutyInput = { name: string; source: "ask" | "file" | "trigger" | "cred" | "literal"; prompt?: string; value?: string };
export type DutyTrigger = { kind: "manual" | "webhook"; secret?: string };
export type Duty = {
  id: string; name: string; summary: string; status: DutyStatus; machine: string; reportsTo: string;
  exclusive?: boolean; inputs: DutyInput[]; steps: DutyNode[]; triggers: DutyTrigger[];
  updatedAt: number; lastRunAt?: number;
};

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SELECTOR_LABEL_RE = /^[#.[]|^role=|^css=/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTarget(target: unknown, path: string, errors: string[]): void {
  if (!isRecord(target)) { errors.push(`${path}: target must be an object`); return; }
  if (!["role", "name", "text", "css"].some((k) => typeof target[k] === "string" && target[k])) {
    errors.push(`${path}: target needs at least one of role, name, text, css`);
  }
}

function validateNodes(nodes: unknown, path: string, errors: string[], seenIds: Set<string>): void {
  if (!Array.isArray(nodes)) { errors.push(`${path}: steps must be an array`); return; }
  nodes.forEach((node, index) => {
    const p = `${path}[${index}]`;
    if (!isRecord(node)) { errors.push(`${p}: must be an object`); return; }
    if (typeof node.label !== "string" || !node.label.trim()) { errors.push(`${p}: label is required`); }
    else if (SELECTOR_LABEL_RE.test(node.label.trim())) { errors.push(`${p}: label must be in the owner's words, not a selector`); }
    if (node.kind === "when") {
      if (!isRecord(node.cond)) errors.push(`${p}: when needs a cond`);
      validateNodes(node.then, `${p}.then`, errors, seenIds);
      if (node.else !== undefined) validateNodes(node.else, `${p}.else`, errors, seenIds);
      return;
    }
    if (node.kind === "stop") {
      if (typeof node.reason !== "string" || !node.reason.trim()) errors.push(`${p}: stop needs a reason`);
      return;
    }
    if (!STEP_KINDS.includes(node.kind as StepKind)) { errors.push(`${p}: unknown step kind "${String(node.kind)}"`); return; }
    if (typeof node.id !== "string" || !node.id) errors.push(`${p}: step id is required`);
    else if (seenIds.has(node.id)) errors.push(`${p}: duplicate step id "${node.id}"`);
    else seenIds.add(node.id);
    if (!isRecord(node.params)) errors.push(`${p}: params must be an object`);
    if (node.target !== undefined) validateTarget(node.target, p, errors);
  });
}

export function validateDuty(input: unknown): { ok: true; duty: Duty } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["duty must be an object"] };
  if (typeof input.id !== "string" || !ID_RE.test(input.id)) errors.push("id must be a kebab-case slug");
  if (typeof input.name !== "string" || !input.name.trim()) errors.push("name is required");
  if (typeof input.summary !== "string") errors.push("summary is required");
  if (!DUTY_STATUSES.includes(input.status as DutyStatus)) errors.push(`status must be one of ${DUTY_STATUSES.join(", ")}`);
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
  ctx: { out: Record<string, unknown>; in: Record<string, unknown>; cred?: (key: string) => Promise<string> },
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
