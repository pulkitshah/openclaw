// Pure render functions for the Duties Control UI page. No DOM access here — every function
// takes plain data and returns an HTML string so it can be unit tested without jsdom. `index.ts`
// owns the DOM/host wiring and simply assigns these strings to `element.innerHTML`.
import type { DeskHealth } from "../src/desk.js";
import type {
  Duty,
  DutyInput,
  DutyNode,
  DutyStatus,
  DutyTrigger,
  Step as DutyStep,
} from "../src/duty.js";
import type { MailStatus } from "../src/mail.js";
import type { DutiesSettings, DutyRun, RunFile, RunStatus, StepEvidence } from "../src/store.js";
import type { Brand, Template } from "../src/template.js";

/** `duties.desk.status`'s reply shape: the health file's own facts (or just `hosted: false` on a
 *  laptop install) plus the RunManager's live ceiling and current activity. */
export type DeskStatusView = DeskHealth & {
  maxParallelRuns: number;
  active: number;
  queued: number;
};

/** Coerces an arbitrary value to text before escaping it, without relying on Object's default
 *  `toString` ("[object Object]"): an object or array is JSON-encoded instead. */
function textOf(value: unknown): string {
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

function esc(value: unknown): string {
  return textOf(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtWhen(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return "";
  }
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

function isToday(ms: number): boolean {
  const now = new Date();
  const then = new Date(ms);
  return (
    now.getFullYear() === then.getFullYear() &&
    now.getMonth() === then.getMonth() &&
    now.getDate() === then.getDate()
  );
}

/** Inline error block rendered at the top of the current view, with a `data-retry` control the
 * host wires to re-run whatever request last failed (a load, or the action that just failed). */
function renderErrorBanner(message: string): string {
  return `<div class="error"><span>${esc(message)}</span><button class="btn" data-retry>Retry</button></div>`;
}

export type RenderOpts = { error?: string };

/** Placeholder shown in place of a view's content while it hasn't loaded yet — a direct
 * navigation into a `detail`/`run` view whose single load fails renders the error banner (with
 * its `data-retry` control) here instead of leaving a bare "Loading…" forever. */
export function renderPlaceholder(opts: RenderOpts): string {
  return opts.error ? renderErrorBanner(opts.error) : `<p class="muted">Loading…</p>`;
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
  if (kind === "ai") {
    return "AI";
  }
  if (kind === "browser.evaluate") {
    return "Script";
  }
  if (kind === "when") {
    return "When";
  }
  if (kind === "stop") {
    return "Stop";
  }
  if (kind === "template") {
    return "Template";
  }
  if (kind === "deliver") {
    return "Deliver";
  }
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

function triggerChipLabel(trigger: DutyTrigger): string {
  if (trigger.kind === "mail") {
    return `Mail: ${trigger.match}`;
  }
  if (trigger.kind === "chat") {
    return `Chat: ${trigger.match}`;
  }
  return "Manual";
}

function triggerChips(triggers: readonly DutyTrigger[]): string {
  return triggers.map((t) => `<span class="chip trig">${esc(triggerChipLabel(t))}</span>`).join("");
}

function lastSuccessfulRun(dutyId: string, runs: readonly DutyRun[]): DutyRun | undefined {
  return runs
    .filter((r) => r.dutyId === dutyId && r.status === "ok")
    .toSorted((a, b) => b.startedAt - a.startedAt)[0];
}

/** The newest failed/blocked run that is still its Duty's newest run. A failure the Duty has since
 * run past is resolved by that later success and must stop winning the Board's banner. */
function newestUnresolvedRun(runs: readonly DutyRun[]): DutyRun | undefined {
  const newestPerDuty = new Map<string, DutyRun>();
  for (const run of runs) {
    const seen = newestPerDuty.get(run.dutyId);
    if (!seen || run.startedAt > seen.startedAt) {
      newestPerDuty.set(run.dutyId, run);
    }
  }
  return [...newestPerDuty.values()]
    .filter((r) => r.status === "failed" || r.status === "blocked")
    .toSorted((a, b) => b.startedAt - a.startedAt)[0];
}

function dutyCard(duty: Duty, runs: readonly DutyRun[]): string {
  const last = lastSuccessfulRun(duty.id, runs);
  const actions =
    duty.status === "building"
      ? `<button class="btn quiet" data-build="${esc(duty.id)}">Continue with agent</button>`
      : `<button class="btn quiet" data-run="${esc(duty.id)}">Run</button><button class="btn quiet" data-edit="${esc(duty.id)}">Edit with agent</button>`;
  const lastRun = last
    ? `Last run <a href="#" class="ok" data-open-run="${esc(last.id)}" data-duty-id="${esc(duty.id)}">✓ ${esc(fmtWhen(last.startedAt))}</a>`
    : "Never run";
  return `<article class="card" data-duty="${esc(duty.id)}">
  <div class="top"><h3 data-open="${esc(duty.id)}">${esc(duty.name)}</h3>${statusPill(duty.status)}</div>
  <p class="sum">${esc(duty.summary)}</p>
  <div class="chips">${triggerChips(duty.triggers)}</div>
  <div class="foot"><span>${lastRun} · updated ${esc(fmtWhen(duty.updatedAt))}</span><span>${actions}</span></div>
</article>`;
}

/** Alphabetical: the channel list the owner target form offers, matching the channel plugins
 *  that can carry an approval/question to a person. */
const OWNER_CHANNELS = ["discord", "signal", "slack", "telegram", "whatsapp"] as const;

/** The Team panel's empty-roster fallback: before anyone (including the owner) has a channel
 *  identity on file, `teamPanel` falls back to this original owner-target form so the very first
 *  person can tell Vasu where to reach them. Once `duties.team.get` returns at least one member
 *  (the owner is seeded on first read — see `src/gateway-methods.ts`), this is never shown again. */
function ownerSettingsForm(settings: DutiesSettings | undefined): string {
  const owner = settings?.owner;
  const options = OWNER_CHANNELS.map(
    (channel) =>
      `<option value="${channel}"${owner?.channel === channel ? " selected" : ""}>${channel}</option>`,
  ).join("");
  return `<div class="ownerform"><label class="fld"><span>Channel</span><select data-settings-channel>${options}</select></label><label class="fld"><span>Target</span><input type="text" data-settings-target value="${esc(owner?.target ?? "")}" placeholder="chat id, phone, @handle"></label><button class="btn primary" data-settings-save>Save</button></div>`;
}

/** The browser bundle's own structural view of `duties.team.get`'s reply — declared here rather
 *  than imported from `src/team.js` so the Control UI bundle stays independent of the plugin's
 *  server modules, the way `DutiesSettings`/`MailStatus` above already are. A read-level caller
 *  gets every field except a channel's `senderId` (the Gateway method itself never withholds it —
 *  the omission is a Control UI display choice, e.g. `canAdmin` gating below). */
export type TeamMemberView = {
  id: string;
  name: string;
  role: "owner" | "member";
  agentId: string;
  bootstrapPending: boolean;
  channels: Array<{ channel: string; senderId?: string }>;
};
export type TeamView = { members: TeamMemberView[]; warnings?: string[] };

function teamRow(member: TeamMemberView, canAdmin: boolean): string {
  const role = member.role === "owner" ? "Owner" : "Member";
  const channels = member.channels
    .map((c) =>
      canAdmin && c.senderId
        ? `<span class="chip">${esc(c.channel)} · <span class="mono">${esc(c.senderId)}</span></span>`
        : `<span class="chip">${esc(c.channel)}</span>`,
    )
    .join("");
  const agent = member.bootstrapPending
    ? `<span class="mono">${esc(member.agentId)}</span> · Setting up`
    : `<span class="mono">${esc(member.agentId)}</span>`;
  const actions =
    canAdmin && member.role !== "owner"
      ? `<button class="btn" data-team-transfer="${esc(member.id)}">Make owner</button>` +
        `<button class="btn" data-team-remove="${esc(member.id)}">Remove</button>`
      : "";
  // Adding a channel is available on every row INCLUDING the owner's — that form is what replaced
  // the Owner card, so the owner adds their WhatsApp here rather than anywhere else.
  const addChannel = canAdmin
    ? `<span class="taddchan"><select data-team-row-channel="${esc(member.id)}">${OWNER_CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select>` +
      `<input type="text" data-team-row-sender="${esc(member.id)}" placeholder="their id on that channel">` +
      `<button class="btn" data-team-channel-add="${esc(member.id)}">Add a channel</button></span>`
    : "";
  return `<div class="teamrow"><span class="tname">${esc(member.name)}</span><span class="trole">${role}</span><span class="tchans">${channels}</span><span class="tagent">${agent}</span><span class="tacts">${actions}${addChannel}</span></div>`;
}

/** Who Vasu takes instructions from. Everyone here can reach Vasu on the channels listed, and gets
 *  their own assistant. Hiding the buttons is cosmetic: `duties.team.*` is gated at
 *  `operator.admin` server-side, which is the actual authority check. */
export function teamPanel(view: TeamView | undefined, canAdmin: boolean): string {
  if (!view) {
    return `<div><h3>Team</h3><p class="muted small">Loading…</p></div>`;
  }
  if (view.members.length === 0) {
    return `<div><h3>Team</h3><p class="muted small">Tell Vasu where to reach you. That makes you the first person on the Team.</p>${ownerSettingsForm(undefined)}</div>`;
  }
  const warnings = (view.warnings ?? [])
    .map((w) => `<p class="muted small warn">${esc(w)}</p>`)
    .join("");
  const rows = view.members.map((m) => teamRow(m, canAdmin)).join("");
  const add = canAdmin
    ? `<div class="teamadd"><label class="fld"><span>Name</span><input type="text" data-team-name placeholder="Ramesh"></label>` +
      `<label class="fld"><span>Channel</span><select data-team-channel>${OWNER_CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></label>` +
      `<label class="fld"><span>Their id on that channel</span><input type="text" data-team-sender placeholder="chat id, phone, @handle"></label>` +
      `<button class="btn primary" data-team-add>Add someone</button></div>`
    : "";
  return `<div><h3>Team</h3><p class="muted small">Who Vasu takes instructions from. Everyone here can reach Vasu on the channels listed, and gets their own assistant.</p>${warnings}<div class="teamlist">${rows}</div>${add}</div>`;
}

const MAIL_CHECKS: ReadonlyArray<{ key: keyof MailStatus; label: string }> = [
  { key: "hooksEnabled", label: "Hooks enabled" },
  { key: "gmailAccountSet", label: "Gmail account set" },
  { key: "mappingPresent", label: "Mapped to the mail agent" },
  { key: "agentPresent", label: "Mail agent present" },
];

/** Four ✓/✗ checks plus the last dispatch; the setup instruction only appears once one of the
 *  four is missing, since a fully wired mail trigger needs nothing further from the owner. */
function mailHealthLine(status: MailStatus | undefined): string {
  if (!status) {
    return `<p class="muted small">Loading…</p>`;
  }
  if (!status.configured) {
    return `<p class="muted small">Mail isn't connected on this desk.</p>`;
  }
  const marks = MAIL_CHECKS.map(
    ({ key, label }) =>
      `<span class="mcheck ${status[key] ? "ok" : "bad"}">${status[key] ? "✓" : "✗"} ${esc(label)}</span>`,
  ).join("");
  const last = status.lastDispatchAt
    ? `Last dispatch ${esc(fmtWhen(status.lastDispatchAt))}${
        status.lastDispatchDutyId
          ? ` for <span class="mono">${esc(status.lastDispatchDutyId)}</span>`
          : ""
      }`
    : "No mail dispatched yet.";
  const needsSetup =
    !status.hooksEnabled ||
    !status.gmailAccountSet ||
    !status.mappingPresent ||
    !status.agentPresent;
  const setup = needsSetup
    ? `<p class="mono small">Run: vasudev duties setup-mail --account &lt;you@…&gt;</p>`
    : "";
  return `<div class="mchecks">${marks}</div><p class="muted small">${last}</p>${setup}`;
}

/** The health file's own boolean facts, in display order — spec §8's "Gateway, display, Chromium,
 *  Tailscale, mail watcher" chip row. `load1`/`memFreeMb` are numeric and shown as a text line
 *  underneath instead, alongside `at`. "Chromium ready" means the browser is INSTALLED for the
 *  service user (`desk-health.sh` checks the Playwright cache dir), not that a run currently has
 *  one open — a run-only reading would make "all chips green" unreachable at idle. */
const DESK_CHECKS: ReadonlyArray<{
  key: "provisioned" | "gateway" | "display" | "chromium" | "tailscale" | "mailWatcher";
  label: string;
}> = [
  { key: "provisioned", label: "Provisioned" },
  { key: "gateway", label: "Gateway" },
  { key: "display", label: "Display" },
  { key: "chromium", label: "Chromium ready" },
  { key: "tailscale", label: "Tailscale" },
  { key: "mailWatcher", label: "Mail watcher" },
];

/** Past this, the chips are shown greyed with their age spelled out: the probe runs every two
 *  minutes, so anything older than two misses means the timer (or the box) is in trouble and the
 *  last reading is not evidence of anything. */
const DESK_STALE_AFTER_MS = 5 * 60_000;

function deskLoadLine(desk: DeskHealth): string {
  const parts: string[] = [];
  if (typeof desk.load1 === "number") {
    parts.push(`load ${desk.load1.toFixed(2)}`);
  }
  if (typeof desk.memFreeMb === "number") {
    parts.push(`${desk.memFreeMb} MB free`);
  }
  return parts.join(" · ");
}

/** How old the reading is, in the words the owner needs when chips disagree with reality. Empty
 *  when the file carries no usable `at` (or one in the future — a clock that has just been set),
 *  since "unknown age" must not read as "fresh". */
function deskAgeLabel(at: number | undefined, nowMs: number): string {
  if (typeof at !== "number" || !Number.isFinite(at)) {
    return "";
  }
  const ageMs = nowMs - at;
  if (ageMs < 0) {
    return "";
  }
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) {
    return "checked just now";
  }
  if (minutes < 60) {
    return `checked ${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `checked ${hours}h ago`;
  }
  return `checked ${Math.floor(hours / 24)}d ago`;
}

/** Spec §8: health chips (Provisioned · Gateway · Display · Chromium · Tailscale · Mail · load)
 *  plus the `maxParallelRuns` number input. The chips (and the load/activity lines) only mean
 *  anything on an actual hosted desk, so they are hidden — never the input itself — on a laptop
 *  install or before the first `duties.desk.status` reply, so the owner can still change the limit
 *  on a install that has never been "hosted" at all.
 *
 *  Every chip row carries the reading's age, and goes grey past `DESK_STALE_AFTER_MS`: the health
 *  file is written by a timer on the desk, so when that timer stops (or the box wedges) the file
 *  keeps its last values. Rendering green chips from a file nobody is updating any more is the one
 *  way this card can actively mislead during an incident. */
function deskCard(
  settings: DutiesSettings | undefined,
  desk: DeskStatusView | undefined,
  nowMs: number = Date.now(),
): string {
  const parallelValue = settings?.maxParallelRuns ?? desk?.maxParallelRuns ?? 4;
  const input = `<label class="fld"><span>Max parallel runs</span><input type="number" min="1" max="8" step="1" data-parallel-save value="${esc(parallelValue)}"></label>`;
  if (!desk) {
    return `<div><h3>Desk</h3><p class="muted small">Loading…</p>${input}</div>`;
  }
  if (!desk.hosted) {
    return `<div><h3>Desk</h3><p class="muted small">Not a hosted desk.</p>${input}</div>`;
  }
  const age = deskAgeLabel(desk.at, nowMs);
  const stale =
    typeof desk.at !== "number" || !Number.isFinite(desk.at)
      ? true
      : nowMs - desk.at > DESK_STALE_AFTER_MS;
  // Some checks are only meaningful on a desk that offers the capability at all (mail watcher
  // needs hooks.gmail, which a client-profile desk never renders) — an absent field is a fact
  // worth carrying (extensions/duties/src/desk.ts already drops it from DeskHealth), not a
  // permanent red chip nothing on that desk can ever turn green.
  const marks = DESK_CHECKS.filter(({ key }) => desk[key] !== undefined)
    .map(({ key, label }) => {
      const ok = desk[key] === true;
      const tone = stale ? "stale" : ok ? "ok" : "bad";
      return `<span class="mcheck ${tone}">${ok ? "✓" : "✗"} ${esc(label)}</span>`;
    })
    .join("");
  const load = deskLoadLine(desk);
  const activity = `${desk.active}/${desk.maxParallelRuns} running${desk.queued ? `, ${desk.queued} queued` : ""}`;
  const staleNote = stale
    ? `<p class="muted small">Health readings are stale${age ? ` (${age})` : ""} — the desk's health timer has not reported recently, so the chips above are its last known state, not its current one.</p>`
    : "";
  const facts = [load, activity, age].filter(Boolean).join(" · ");
  return `<div><h3>Desk</h3><div class="mchecks">${marks}</div><p class="muted small">${esc(facts)}</p>${staleNote}${input}</div>`;
}

function settingsStrip(
  settings: DutiesSettings | undefined,
  mailStatus: MailStatus | undefined,
  deskStatus: DeskStatusView | undefined,
  team: TeamView | undefined,
  canAdmin: boolean,
): string {
  return `<div class="panel settings"><div class="ph"><h2>Settings</h2></div><div class="pb"><div class="two-col">
  ${teamPanel(team, canAdmin)}
  <div><h3>Mail trigger</h3>${mailHealthLine(mailStatus)}</div>
  ${deskCard(settings, deskStatus)}
</div></div></div>`;
}

export type BoardOpts = RenderOpts & {
  settings?: DutiesSettings;
  mailStatus?: MailStatus;
  deskStatus?: DeskStatusView;
  team?: TeamView;
  canAdmin?: boolean;
};

export function renderBoard(
  duties: readonly Duty[],
  runs: readonly DutyRun[],
  opts?: BoardOpts,
): string {
  const errorBanner = opts?.error ? renderErrorBanner(opts.error) : "";
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
  return `${errorBanner}<div class="head"><div><h1>Duties</h1><p>Everything your digital employee runs for you — what it does, when, and whether it worked.</p></div><div class="actions"><button class="btn" data-nav="templates">Templates</button><button class="btn" data-nav="logins">Logins</button><button class="btn primary" data-edit="new">New Duty · chat with the agent</button></div></div>
<div class="rollup">
  <div class="roll"><div class="n">${active}</div><div class="l">Active</div></div>
  <div class="roll"><div class="n">${successfulToday}</div><div class="l">Successful runs today</div></div>
  <div class="roll${waiting ? " alert" : ""}"><div class="n">${waiting}</div><div class="l">Waiting on you</div></div>
  <div class="roll"><div class="n">${building}</div><div class="l">Being built with the agent</div></div>
</div>
${banner}
${settingsStrip(opts?.settings, opts?.mailStatus, opts?.deskStatus, opts?.team, opts?.canAdmin ?? true)}
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
  const label =
    trigger.kind === "mail"
      ? "Mail"
      : trigger.kind === "chat"
        ? "Chat"
        : "Manual (chat or Run button)";
  const detail = trigger.kind === "mail" || trigger.kind === "chat" ? trigger.match : "—";
  return `<dt>${esc(label)}</dt><dd>${esc(detail)}</dd>`;
}

/** Spec §8: a run that delivered something shows "Delivered to <channel>" on the Board / Duty
 *  page. The deliver step's own evidence summary is the runner's `→ ${channel}:${maskTarget}`
 *  string (`src/runner.ts`); only its leading arrow is stripped, since the recipient is already
 *  masked there and must stay that way here. */
function deliveredToNote(run: DutyRun): string | undefined {
  const delivered = run.steps.find((s) => s.kind === "deliver" && s.status === "ok");
  if (!delivered) {
    return undefined;
  }
  return `Delivered to ${delivered.summary.replace(/^→\s*/u, "")}`;
}

function successfulRunRow(run: DutyRun): string {
  const delivered = deliveredToNote(run);
  return `<li><span class="st ok">✓</span><span class="when">${esc(fmtWhen(run.startedAt))}</span><span class="r">${esc(run.trigger)}${
    delivered ? ` · ${esc(delivered)}` : ""
  }</span><a href="#" data-open-run="${esc(run.id)}" data-duty-id="${esc(run.dutyId)}">view run</a></li>`;
}

export function renderDetail(duty: Duty, runs: readonly DutyRun[], opts?: RenderOpts): string {
  const errorBanner = opts?.error ? renderErrorBanner(opts.error) : "";
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
  return `${errorBanner}<div class="head"><div><div class="small"><a href="#" data-nav="board">← Duties</a></div><h1>${esc(duty.name)}</h1>
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

/** A screenshot is fetched only when the owner asks for it (`data-shot`), and the blob id itself
 * never reaches the page: the host requests `duties.run.evidence` by step id. Screenshots are the
 * only page evidence retained — snapshot text never is. */
function stepEvidenceRow(step: StepEvidence): string {
  const st = step.status === "ok" ? "ok" : step.status === "failed" ? "fail" : "blocked";
  const mark = step.status === "ok" ? "✓" : step.status === "failed" ? "✕" : "–";
  const shot = step.screenshotBlobId
    ? `<div class="shotwrap"><button class="btn quiet" data-shot="${esc(step.stepId)}">Screenshot</button><div class="shot" data-shot-for="${esc(step.stepId)}" hidden></div></div>`
    : "";
  return `<li class="step"><span class="st ${st}">${mark}</span><div><div class="t">${esc(step.label)}</div><div class="d">${esc(step.summary)}</div>${shot}</div><span class="kind ${esc(step.kind)}">${esc(kindLabel(step.kind))}</span></li>`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PDF_CONTENT_TYPE = "application/pdf";

/** A document a run produced (e.g. a rendered PDF). Fetched only when the owner opens a toggle;
 *  the file's disk path never reaches the page. A PDF gets a lazily-loaded PNG preview (shown as
 *  an `<img>`, click to expand — `data:`/`blob:` images are unaffected by the host's `frame-src`
 *  CSP, unlike an iframe) plus an "Open PDF" button that opens a `blob:` object URL in a new tab.
 *  A non-PDF file only gets the "Open" button, which opens the same way. Never an iframe: the
 *  Control UI's `frame-src` does not include `data:` (or `blob:`), so a framed document is
 *  silently blocked (final review, C4). */
function fileRow(file: RunFile): string {
  const isPdf = file.contentType === PDF_CONTENT_TYPE;
  const preview = isPdf
    ? `<button class="btn quiet" data-file-shot="${esc(file.stepId)}">Preview</button><div class="filepreview" data-file-shot-for="${esc(file.stepId)}" hidden></div>`
    : "";
  const openLabel = isPdf ? "Open PDF" : "Open";
  return `<li><span class="mono">${esc(file.name)}</span><span class="when">${esc(formatBytes(file.bytes))}</span>${preview}<button class="btn quiet" data-file-open="${esc(file.stepId)}">${esc(openLabel)}</button></li>`;
}

/** What the run page needs to show the "Now" panel: the newest step (by evidence order) while a
 *  run is still `running`/`queued`, plus its screenshot once `index.ts` has fetched one via
 *  `duties.run.evidence` (fetched only when the newest step id changes, never on every redraw). */
export type NowShot = { stepId: string; imageDataUrl?: string };

/** While a run is in flight, shows the newest step's label and (once fetched) its screenshot at
 *  the top of the page, so the owner sees where the run currently is without opening a step's
 *  own toggle. Renders nothing once the run has finished (its own step rows carry the full
 *  history). A step kind with no screenshot (e.g. `ask`, `deliver`) says so instead of an empty
 *  image. */
function nowPanel(run: DutyRun, now: NowShot | undefined): string {
  if (run.status !== "running" && run.status !== "queued") {
    return "";
  }
  const newest = run.steps.at(-1);
  const label = newest ? esc(newest.label) : "Starting…";
  let body: string;
  if (!newest) {
    body = `<p class="muted small">Waiting for the first step…</p>`;
  } else if (!newest.screenshotBlobId) {
    body = `<p class="muted small">No screenshot for this step.</p>`;
  } else if (now && now.stepId === newest.stepId && now.imageDataUrl) {
    body = `<img class="nowshot" alt="Current step" src="${esc(now.imageDataUrl)}">`;
  } else {
    body = `<p class="muted small">Loading…</p>`;
  }
  return `<div class="panel now"><div class="ph"><h2>Now</h2><span class="muted small">${label}</span></div><div class="pb">${body}</div></div>`;
}

export type RunOpts = RenderOpts & { now?: NowShot };

export function renderRun(run: DutyRun, duty: Duty | undefined, opts?: RunOpts): string {
  const errorBanner = opts?.error ? renderErrorBanner(opts.error) : "";
  const outputEntries = Object.entries(run.outputs);
  const files = run.files ?? [];
  const delivered = deliveredToNote(run);
  return `${errorBanner}<div class="head"><div><div class="small"><a href="#" data-nav="board">← Board</a> · <a href="#" data-open="${esc(duty?.id ?? run.dutyId)}">${esc(duty?.name ?? run.dutyId)}</a></div><h1>Run</h1>
<div class="meta">${runStatusPill(run.status)}<span>Started <b>${esc(fmtWhen(run.startedAt))}</b></span>${
    run.endedAt ? `<span>Ended <b>${esc(fmtWhen(run.endedAt))}</b></span>` : ""
  }<span>Trigger <b>${esc(run.trigger)}</b></span>${
    delivered ? `<span>${esc(delivered)}</span>` : ""
  }</div></div>
${
  run.status === "running" || run.status === "queued"
    ? `<button class="btn danger" data-cancel="${esc(run.id)}">Cancel run</button>`
    : ""
}</div>
${nowPanel(run, opts?.now)}
${run.report ? `<div class="panel"><div class="pb">${esc(run.report)}</div></div>` : ""}
<div class="panel"><div class="ph"><h2>Steps</h2></div><div class="pb">${
    run.steps.length
      ? `<ol class="steps">${run.steps.map(stepEvidenceRow).join("")}</ol>`
      : `<p class="muted">No step evidence yet.</p>`
  }</div></div>
${
  files.length
    ? `<div class="panel"><div class="ph"><h2>Files</h2></div><div class="pb"><ul class="runs files">${files.map(fileRow).join("")}</ul></div></div>`
    : ""
}
<div class="panel"><div class="ph"><h2>Outputs</h2></div><div class="pb"><dl class="kv">${
    outputEntries.length
      ? outputEntries
          .map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(JSON.stringify(value))}</dd>`)
          .join("")
      : `<dd class="muted">—</dd>`
  }</dl></div></div>`;
}

// ---------- Logins ----------

/**
 * Hand-mirrored copy of `CRED_KEY_RE` in `src/creds.ts` (that module imports `node:child_process`,
 * so the browser bundle cannot import it). It only pre-validates the field; `credSet`'s own
 * `assertKey` remains the authority.
 */
const CRED_KEY_PATTERN = "[a-z0-9][a-z0-9_.-]{0,63}";

export type LoginsView = { keys: readonly string[]; updatedAt: Record<string, number> };

/**
 * The owner's only entry point for storing a credential. The value is typed into a password field,
 * posted straight to `duties.cred.set`, and never rendered, echoed back, or kept in the page: this
 * panel only ever shows which keys exist and when each was last written.
 */
export function renderLogins(view: LoginsView, opts?: RenderOpts): string {
  const errorBanner = opts?.error ? renderErrorBanner(opts.error) : "";
  const rows = view.keys
    .map(
      (key) =>
        `<li><span class="mono">${esc(key)}</span><span class="when">saved ${esc(fmtWhen(view.updatedAt[key]))}</span><button class="btn danger" data-cred-delete="${esc(key)}">Delete</button></li>`,
    )
    .join("");
  return `${errorBanner}<div class="head"><div><div class="small"><a href="#" data-nav="board">← Duties</a></div><h1>Logins</h1>
<p>Passwords a Duty signs in with. They go straight into this machine's keychain — the agent never sees a value, and neither does this page.</p></div></div>
<div class="two">
  <div class="panel"><div class="ph"><h2>Saved logins</h2></div><div class="pb">${
    rows ? `<ul class="runs logins">${rows}</ul>` : `<p class="muted">No logins saved yet.</p>`
  }</div></div>
  <div class="panel"><div class="ph"><h2>Add a login</h2></div><div class="pb">
    <label class="fld"><span>Key</span><input type="text" data-cred-key placeholder="site.password" pattern="${CRED_KEY_PATTERN}" autocomplete="off" spellcheck="false"></label>
    <label class="fld"><span>Value</span><input type="password" data-cred-value autocomplete="new-password"></label>
    <button class="btn primary" data-cred-save>Save login</button>
  </div></div>
</div>`;
}

// ---------- Templates & brand ----------

function pluralSlots(count: number): string {
  return `${count} slot${count === 1 ? "" : "s"}`;
}

/** `duties.template.preview` (`src/preview.ts`) only ever renders `pdf` templates and throws for
 *  a `message` one, so the Preview/Open PDF buttons — which call that method — are offered only
 *  for `pdf` templates. A `message` template's body is plain text already sitting in
 *  `template.html`, so it is shown inline behind a `<details>` toggle instead: no Gateway round
 *  trip needed or offered. */
function templateBody(template: Template): string {
  if (template.kind === "pdf") {
    return `<div class="tplpreview" data-tpl-preview-for="${esc(template.id)}" hidden></div>`;
  }
  return `<details class="tpltext"><summary>Message text</summary><pre class="raw">${esc(template.html)}</pre></details>`;
}

/** Preview and delete are the only mutations this page performs on a template; content edits go
 *  through the agent (`data-tpl-edit`, mirroring `data-edit` on a Duty), since a template's HTML
 *  and slot contract are hand-authored and validated server-side, not form fields here.
 *
 *  A `pdf` template gets two independent actions: "Preview" toggles a lazily-loaded PNG `<img>`
 *  (click to expand) below the card, and "Open PDF" fetches the same render and opens it as a
 *  `blob:` object URL in a new tab — never an iframe (final review, C4: the Control UI's
 *  `frame-src` blocks `data:`/`blob:` framed content, but a top-level navigation is unaffected). */
function templateCard(template: Template): string {
  const pdfActions =
    template.kind === "pdf"
      ? `<button class="btn quiet" data-tpl-preview="${esc(template.id)}">Preview</button><button class="btn quiet" data-tpl-pdf="${esc(template.id)}">Open PDF</button>`
      : "";
  return `<article class="card tpl" data-tpl="${esc(template.id)}">
  <div class="top"><h3>${esc(template.name)}</h3><span class="chip">${esc(template.kind)}</span></div>
  <p class="sum">${esc(pluralSlots(template.slots.length))} · updated ${esc(fmtWhen(template.updatedAt))}</p>
  <div class="foot"><span></span><span>${pdfActions}<button class="btn quiet" data-tpl-edit="${esc(template.id)}">Edit with agent</button><button class="btn danger" data-tpl-delete="${esc(template.id)}">Delete</button></span></div>
  ${templateBody(template)}
</article>`;
}

/** The logo is read client-side (FileReader → data URL) and posted as `Brand.logoDataUrl`; no
 *  separate upload endpoint exists, matching `validateBrand`'s `data:image/...` contract. */
function brandForm(brand: Brand | undefined): string {
  return `<div class="panel"><div class="ph"><h2>Brand</h2></div><div class="pb">
  <label class="fld"><span>Name</span><input type="text" data-brand-name value="${esc(brand?.name ?? "")}"></label>
  <label class="fld"><span>Logo</span><input type="file" accept="image/*" data-brand-logo></label>
  ${brand?.logoDataUrl ? `<img class="brandlogo" src="${esc(brand.logoDataUrl)}" alt="Current logo">` : ""}
  <label class="fld"><span>Primary colour</span><input type="color" data-brand-primary value="${esc(brand?.primary ?? "#111111")}"></label>
  <label class="fld"><span>Accent colour</span><input type="color" data-brand-accent value="${esc(brand?.accent ?? "#2563eb")}"></label>
  <label class="fld"><span>Phone</span><input type="text" data-brand-phone value="${esc(brand?.phone ?? "")}"></label>
  <label class="fld"><span>Email</span><input type="text" data-brand-email value="${esc(brand?.email ?? "")}"></label>
  <label class="fld"><span>Footer</span><input type="text" data-brand-footer value="${esc(brand?.footer ?? "")}"></label>
  <button class="btn primary" data-brand-save>Save brand</button>
</div></div>`;
}

export type TemplatesView = { templates: readonly Template[]; brand?: Brand };

export function renderTemplates(view: TemplatesView, opts?: RenderOpts): string {
  const errorBanner = opts?.error ? renderErrorBanner(opts.error) : "";
  const cards = view.templates.map(templateCard).join("");
  return `${errorBanner}<div class="head"><div><div class="small"><a href="#" data-nav="board">← Duties</a></div><h1>Templates</h1>
<p>Documents and messages a Duty can fill in and send.</p></div></div>
<div class="notice">Ask the agent in chat to create or change a template, e.g. "Make a rate-quote PDF template with columns day, hotel, price."</div>
<div class="grid">${cards || `<p class="muted">No templates yet.</p>`}</div>
${brandForm(view.brand)}`;
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
