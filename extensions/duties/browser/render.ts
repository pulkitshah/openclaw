// Pure render functions for the Duties Control UI page. No DOM access here — every function
// takes plain data and returns an HTML string so it can be unit tested without jsdom. `index.ts`
// owns the DOM/host wiring and simply assigns these strings to `element.innerHTML`.
import type {
  Duty,
  DutyInput,
  DutyNode,
  DutyStatus,
  DutyTrigger,
  Step as DutyStep,
} from "../src/duty.js";
import type { DutyRun, RunStatus, StepEvidence } from "../src/store.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtWhen(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

function isToday(ms: number): boolean {
  const now = new Date();
  const then = new Date(ms);
  return (
    now.getUTCFullYear() === then.getUTCFullYear() &&
    now.getUTCMonth() === then.getUTCMonth() &&
    now.getUTCDate() === then.getUTCDate()
  );
}

const DUTY_STATUS_LABEL: Record<DutyStatus, string> = {
  active: "Active",
  paused: "Paused",
  building: "Building",
};

function statusPill(status: DutyStatus): string {
  return `<span class="pill ${esc(status)}">${esc(DUTY_STATUS_LABEL[status])}</span>`;
}

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  ok: "Succeeded",
  failed: "Failed",
  blocked: "Blocked",
  needs_input: "Waiting on you",
  cancelled: "Cancelled",
  lost: "Lost",
};

function runStatusPill(status: RunStatus): string {
  return `<span class="pill run-${esc(status)}">${esc(RUN_STATUS_LABEL[status])}</span>`;
}

function kindLabel(kind: string): string {
  if (kind === "ai") return "AI";
  if (kind === "browser.evaluate") return "Script";
  if (kind === "when") return "When";
  if (kind === "stop") return "Stop";
  return kind;
}

// ---------- Steps (read-only) ----------

function renderStepRow(step: DutyStep, index: number): string {
  return `<li class="step"><span class="num">${index + 1}</span><div><div class="t">${esc(step.label)}</div></div><span class="kind ${esc(step.kind)}">${esc(kindLabel(step.kind))}</span></li>`;
}

/** Numbers only leaf steps/stops; a `when` node is rendered as a collapsible group (closed by
 * default) around its `then`/`else` branches instead of taking its own number, so a login-check
 * gateway at the top of a duty does not dominate the step count the owner reads at a glance. */
function renderNodes(nodes: readonly DutyNode[], counter: { n: number }): string {
  return nodes.map((node) => renderNode(node, counter)).join("");
}

function renderNode(node: DutyNode, counter: { n: number }): string {
  if (node.kind === "when") {
    const branch = (label: string, steps: readonly DutyNode[] | undefined): string =>
      steps && steps.length
        ? `<div class="branch"><div class="bl">${esc(label)}</div><ol class="steps">${renderNodes(steps, counter)}</ol></div>`
        : "";
    return `<li class="step-group"><details><summary><span class="t">${esc(node.label)}</span><span class="kind when">When</span></summary>${branch("Then", node.then)}${branch("Else", node.else)}</details></li>`;
  }
  if (node.kind === "stop") {
    counter.n += 1;
    return `<li class="step"><span class="num">${counter.n}</span><div><div class="t">${esc(node.label)}</div><div class="d">${esc(node.reason)}</div></div><span class="kind stop">Stop</span></li>`;
  }
  counter.n += 1;
  return renderStepRow(node, counter.n - 1);
}

// ---------- Board ----------

function triggerChips(triggers: readonly DutyTrigger[]): string {
  return triggers
    .map((t) => `<span class="chip trig">${t.kind === "webhook" ? "Webhook" : "Manual"}</span>`)
    .join("");
}

function lastSuccessfulRun(dutyId: string, runs: readonly DutyRun[]): DutyRun | undefined {
  return runs
    .filter((r) => r.dutyId === dutyId && r.status === "ok")
    .toSorted((a, b) => b.startedAt - a.startedAt)[0];
}

function newestUnresolvedRun(runs: readonly DutyRun[]): DutyRun | undefined {
  return runs
    .filter((r) => r.status === "failed" || r.status === "blocked")
    .toSorted((a, b) => b.startedAt - a.startedAt)[0];
}

function dutyCard(duty: Duty, runs: readonly DutyRun[]): string {
  const last = lastSuccessfulRun(duty.id, runs);
  const actions =
    duty.status === "building"
      ? `<button class="btn quiet" data-build="${esc(duty.id)}">Continue with agent</button>`
      : `<button class="btn quiet" data-run="${esc(duty.id)}">Run</button><button class="btn quiet" data-edit="${esc(duty.id)}">Edit with agent</button>`;
  return `<article class="card" data-duty="${esc(duty.id)}">
  <div class="top"><h3 data-open="${esc(duty.id)}">${esc(duty.name)}</h3>${statusPill(duty.status)}</div>
  <p class="sum">${esc(duty.summary)}</p>
  <div class="chips">${triggerChips(duty.triggers)}</div>
  <div class="foot"><span>${last ? `Last run <span class="ok">✓ ${esc(fmtWhen(last.startedAt))}</span>` : "Never run"} · updated ${esc(fmtWhen(duty.updatedAt))}</span><span>${actions}</span></div>
</article>`;
}

export function renderBoard(duties: readonly Duty[], runs: readonly DutyRun[]): string {
  const active = duties.filter((d) => d.status === "active").length;
  const building = duties.filter((d) => d.status === "building").length;
  const successfulToday = runs.filter((r) => r.status === "ok" && isToday(r.startedAt)).length;
  const waiting = runs.filter((r) => r.status === "blocked" || r.status === "needs_input").length;
  const unresolved = newestUnresolvedRun(runs);
  const unresolvedDuty = unresolved ? duties.find((d) => d.id === unresolved.dutyId) : undefined;
  const banner =
    unresolved && unresolvedDuty
      ? `<div class="banner"><div class="grow"><b>${esc(unresolvedDuty.name)}</b> ${
          unresolved.status === "blocked" ? "is blocked" : "failed"
        }${unresolved.failedStep ? ` at <span class="mono">${esc(unresolved.failedStep)}</span>` : ""} at ${esc(fmtWhen(unresolved.startedAt))}.${
          unresolved.report ? ` ${esc(unresolved.report)}` : ""
        }</div><button class="btn primary" data-open-run="${esc(unresolved.id)}" data-duty-id="${esc(unresolvedDuty.id)}">View run</button><button class="btn" data-open="${esc(unresolvedDuty.id)}">Open Duty</button></div>`
      : "";
  const cards = duties.map((d) => dutyCard(d, runs)).join("");
  return `<div class="head"><div><h1>Duties</h1><p>Everything your digital employee runs for you — what it does, when, and whether it worked.</p></div><div class="actions"><button class="btn primary" data-edit="new">New Duty · chat with the agent</button></div></div>
<div class="rollup">
  <div class="roll"><div class="n">${active}</div><div class="l">Active</div></div>
  <div class="roll"><div class="n">${successfulToday}</div><div class="l">Successful runs today</div></div>
  <div class="roll${waiting ? " alert" : ""}"><div class="n">${waiting}</div><div class="l">Waiting on you</div></div>
  <div class="roll"><div class="n">${building}</div><div class="l">Being built with the agent</div></div>
</div>
${banner}
<div class="grid">${cards}<article class="card new" data-edit="new"><b>New Duty</b><span>Describe the job to the agent in any chat. It explores what it needs to, asks what it needs, builds and tests step by step.</span></article></div>`;
}

// ---------- Duty detail ----------

function inputRow(input: DutyInput): string {
  const detail =
    input.source === "cred"
      ? `<span class="keych">from your Keychain, never shown</span>`
      : esc(
          input.source === "ask"
            ? (input.prompt ?? "asked each run")
            : input.source === "literal"
              ? (input.value ?? "")
              : input.source,
        );
  return `<dt>${esc(input.name)}</dt><dd>${detail}</dd>`;
}

function triggerRow(trigger: DutyTrigger): string {
  const label = trigger.kind === "webhook" ? "Webhook" : "Manual (chat or Run button)";
  const detail =
    trigger.kind === "webhook" ? (trigger.secret ? "secret required" : "no secret set") : "—";
  return `<dt>${esc(label)}</dt><dd>${esc(detail)}</dd>`;
}

function successfulRunRow(run: DutyRun): string {
  return `<li><span class="st ok">✓</span><span class="when">${esc(fmtWhen(run.startedAt))}</span><span class="r">${esc(run.trigger)}</span><a href="#" data-open-run="${esc(run.id)}" data-duty-id="${esc(run.dutyId)}">view run</a></li>`;
}

export function renderDetail(duty: Duty, runs: readonly DutyRun[]): string {
  const successful = runs
    .filter((r) => r.dutyId === duty.id && r.status === "ok")
    .toSorted((a, b) => b.startedAt - a.startedAt);
  const steps = duty.steps.length
    ? `<ol class="steps">${renderNodes(duty.steps, { n: 0 })}</ol>`
    : `<p class="muted">No steps yet.</p>`;
  const actions =
    duty.status === "building"
      ? `<button class="btn primary" data-build="${esc(duty.id)}">Continue with agent</button>`
      : `<button class="btn primary" data-run="${esc(duty.id)}">Run</button><button class="btn" data-status="${esc(duty.id)}" data-next="${
          duty.status === "active" ? "paused" : "active"
        }">${duty.status === "active" ? "Pause" : "Resume"}</button><button class="btn" data-edit="${esc(duty.id)}">Edit with agent</button><button class="btn danger" data-delete="${esc(duty.id)}">Delete</button>`;
  return `<div class="head"><div><div class="small"><a href="#" data-nav="board">← Duties</a></div><h1>${esc(duty.name)}</h1>
<div class="meta">${statusPill(duty.status)}<span>Last updated <b>${esc(fmtWhen(duty.updatedAt))}</b></span><span>Last run <b>${
    duty.lastRunAt ? esc(fmtWhen(duty.lastRunAt)) : "never"
  }</b></span><span>Runs on <b>${esc(duty.machine)}</b></span><span>Reports to <b>${esc(duty.reportsTo)}</b></span>${
    duty.exclusive ? `<span>Runs alone <b>yes</b></span>` : ""
  }</div></div>
<div class="actions">${actions}</div></div>
<div class="two">
  <div class="stack">
    <div class="panel"><div class="ph"><h2>What it does</h2></div><div class="pb">${steps}</div></div>
    <div class="panel"><div class="ph"><h2>Successful runs</h2><span class="muted small">Failures reach you as a notification, not here</span></div><div class="pb">${
      successful.length
        ? `<ul class="runs">${successful.map(successfulRunRow).join("")}</ul>`
        : `<p class="muted">No runs yet.</p>`
    }</div></div>
  </div>
  <div class="stack">
    <div class="panel"><div class="ph"><h2>Triggers</h2></div><div class="pb"><dl class="kv">${
      duty.triggers.map(triggerRow).join("") || `<dd class="muted">—</dd>`
    }</dl></div></div>
    <div class="panel"><div class="ph"><h2>Inputs</h2></div><div class="pb"><dl class="kv">${
      duty.inputs.map(inputRow).join("") || `<dd class="muted">—</dd>`
    }</dl></div></div>
  </div>
</div>`;
}

// ---------- Run view ----------

function stepEvidenceRow(step: StepEvidence): string {
  const st = step.status === "ok" ? "ok" : step.status === "failed" ? "fail" : "todo";
  const mark = step.status === "ok" ? "✓" : step.status === "failed" ? "✕" : "–";
  return `<li class="step"><span class="st ${st}">${mark}</span><div><div class="t">${esc(step.label)}</div><div class="d">${esc(step.summary)}</div></div><span class="kind ${esc(step.kind)}">${esc(kindLabel(step.kind))}</span></li>`;
}

export function renderRun(run: DutyRun, duty: Duty | undefined): string {
  const outputEntries = Object.entries(run.outputs);
  return `<div class="head"><div><div class="small"><a href="#" data-open="${esc(duty?.id ?? run.dutyId)}">← ${esc(duty?.name ?? run.dutyId)}</a></div><h1>Run</h1>
<div class="meta">${runStatusPill(run.status)}<span>Started <b>${esc(fmtWhen(run.startedAt))}</b></span>${
    run.endedAt ? `<span>Ended <b>${esc(fmtWhen(run.endedAt))}</b></span>` : ""
  }<span>Trigger <b>${esc(run.trigger)}</b></span></div></div>
${
  run.status === "running" || run.status === "queued"
    ? `<button class="btn danger" data-cancel="${esc(run.id)}">Cancel run</button>`
    : ""
}</div>
${run.report ? `<div class="panel"><div class="pb">${esc(run.report)}</div></div>` : ""}
<div class="panel"><div class="ph"><h2>Steps</h2></div><div class="pb">${
    run.steps.length
      ? `<ol class="steps">${run.steps.map(stepEvidenceRow).join("")}</ol>`
      : `<p class="muted">No step evidence yet.</p>`
  }</div></div>
<div class="panel"><div class="ph"><h2>Outputs</h2></div><div class="pb"><dl class="kv">${
    outputEntries.length
      ? outputEntries
          .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(JSON.stringify(value))}</dd>`)
          .join("")
      : `<dd class="muted">—</dd>`
  }</dl></div></div>`;
}

// ---------- Build session preview (static example; wired for real in Part 2) ----------

type ExampleStep = { kind: string; title: string; state?: "ok" | "run" | "todo" };
type ExampleMessage = { who: "me" | "ai"; text: string; did?: string };

const EXAMPLE_STEPS: readonly ExampleStep[] = [
  { kind: "ai", title: "Read the vendor mail", state: "ok" },
  { kind: "when", title: "Stop if it isn't a rate quote", state: "ok" },
  { kind: "ai", title: "Build the day-by-day plan", state: "ok" },
  { kind: "ask", title: "Ask you if the vendor total is missing", state: "ok" },
  { kind: "browser", title: "Render the quotation", state: "run" },
  { kind: "browser", title: "Send to you for approval", state: "todo" },
];

const EXAMPLE_CHAT: readonly ExampleMessage[] = [
  {
    who: "me",
    text: "When a vendor mails hotel rates for a package, make our quotation and send it to me to approve.",
  },
  {
    who: "ai",
    did: "Read 3 recent vendor mails · wrote the first steps · test run passed",
    text: "Last mail prices at INR 48,600 per person. Next: the quotation itself — do you have one you already send?",
  },
];

function exampleTile(step: ExampleStep): string {
  return `<div class="tile ${step.state ?? "todo"}"><div class="k"><span class="kd kind ${step.kind}">${esc(kindLabel(step.kind))}</span>${
    step.state === "ok" ? `<span class="st">✓</span>` : ""
  }</div><div class="t">${esc(step.title)}</div></div>`;
}

function exampleMessage(message: ExampleMessage): string {
  return `<div class="msg ${message.who}">${message.did ? `<div class="did">${esc(message.did)}</div>` : ""}${esc(message.text)}</div>`;
}

/** Static, illustrative-only render of what a build session will look like once Part 2 wires the
 * live chat mirror to this page. Nothing here calls the Gateway. */
export function renderBuildPreview(): string {
  const tiles = EXAMPLE_STEPS.map(exampleTile).join("");
  const chat = EXAMPLE_CHAT.map(exampleMessage).join("");
  return `<div class="head" style="margin-bottom:14px"><div><div class="small"><a href="#" data-nav="board">← Duties</a></div><h1>Preview — build sessions arrive in the next part</h1>
<p>This is an example of what watching the agent build a Duty will look like. It is not live yet.</p></div></div>
<div class="b2">
  <div class="stage">
    <div class="bar"><span class="muted small">Agent is driving (example)</span></div>
    <div class="live"><div class="desk"></div><div class="win"></div><div class="cap"><i></i>example-vm · Chrome</div></div>
    <div class="trail"><div class="th"><b>Steps so far (example)</b></div><div class="rail">${tiles}</div></div>
  </div>
  <div class="chatp"><div class="ch"><b>Agent (example)</b></div><div class="chat">${chat}</div></div>
</div>`;
}
