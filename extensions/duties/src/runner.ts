import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  | { status: "answered"; answer: string }
  | { status: "timeout" | "cancelled" };
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
  const secrets = new Set<string>();
  let targetId = options.targetId;
  let reachedStop = false;
  const trackedCred = async (key: string): Promise<string> => {
    const value = await deps.cred(key);
    if (value.length >= 4) secrets.add(value);
    return value;
  };
  const redact = (text: string): string => {
    let result = text;
    for (const secret of secrets) result = result.split(secret).join(MASK);
    return result;
  };
  const ctx = () => ({ out: outputs, in: options.inputs, cred: trackedCred });
  const resolve = (value: unknown) =>
    typeof value === "string" ? resolvePlaceholders(value, ctx()) : Promise.resolve(value);
  const requireTab = (): string => {
    if (!targetId) throw new Error("no browser tab: add an open step first");
    return targetId;
  };

  const record = (partial: Omit<StepEvidence, "durationMs"> & { startedAt: number }) => {
    const { startedAt, ...rest } = partial;
    const item: StepEvidence = {
      ...rest,
      summary: redact(rest.summary),
      durationMs: now() - startedAt,
    };
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
      const record = isRecord(value) ? value : undefined;
      for (const key of step.saveAs) outputs[key] = record?.[key];
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
          if (!step.target) throw new Error("click needs a target");
          await deps.browser.click(requireTab(), step.target);
          summary = describeTarget(step.target);
        } else if (action === "fill" || action === "select") {
          if (!step.target) throw new Error(`${action} needs a target`);
          const raw = String(step.params.value ?? "");
          usedCred = /\{\{cred:/u.test(raw);
          const value = String(await resolve(raw));
          if (action === "fill") await deps.browser.fill(requireTab(), step.target, value);
          else await deps.browser.select(requireTab(), step.target, value);
          summary = `${describeTarget(step.target)} ← ${usedCred ? MASK : value}`;
        } else if (action === "press") {
          await deps.browser.press(requireTab(), String(step.params.key));
          summary = String(step.params.key);
        } else if (action === "wait") {
          await deps.browser.waitFor(requireTab(), {
            target: step.target,
            text: typeof step.params.text === "string" ? step.params.text : undefined,
            url: typeof step.params.url === "string" ? step.params.url : undefined,
            timeoutMs: step.timeoutMs,
          });
          summary = "waited";
        } else if (action === "read") {
          const text = await deps.browser.text(requireTab(), step.target);
          save(step, text);
          summary = text.slice(0, 120);
        } else if (action === "screenshot") {
          summary = "screenshot";
        } else {
          throw new Error(`unknown browser action "${action}"`);
        }
      } else if (step.kind === "browser.evaluate") {
        const result = await deps.browser.evaluate(requireTab(), String(step.params.fn));
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
        // SAFETY: options is authored duty config; a missing/non-array value falls back to an empty list.
        const options_ = (step.params.options as string[] | undefined) ?? [];
        const result = await deps.ask.ask({
          stepId: step.id,
          question: String(await resolve(step.params.question)),
          header: String(step.params.header ?? step.label).slice(0, 12),
          options: options_,
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
        summary: error instanceof HaltSignal ? error.message : errorMessage(error),
        startedAt,
        screenshotBlobId: shot,
      });
      throw error instanceof HaltSignal
        ? error
        : new HaltSignal("failed", step.id, errorMessage(error));
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
