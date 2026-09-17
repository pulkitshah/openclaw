// Pure render functions for the Team Control UI page. No DOM access here — `index.ts` owns the
// DOM/host wiring and simply assigns these strings to `element.innerHTML`. Split out of
// `extensions/duties/browser/render.ts` (Team v2 Task 1): this plugin's control-ui bundle is built
// independently of Duties', so its own small copies of `esc`/`renderErrorBanner`/`RenderOpts` live
// here rather than being imported across the plugin boundary.

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

/** Inline error block rendered at the top of the current view, with a `data-retry` control the
 *  host wires to re-run whatever request last failed (a load, or the action that just failed). */
function renderErrorBanner(message: string): string {
  return `<div class="error"><span>${esc(message)}</span><button class="btn" data-retry>Retry</button></div>`;
}

export type RenderOpts = { error?: string };

/** Alphabetical: the channel list the owner-target and add-someone forms offer, matching the
 *  channel plugins that can carry an approval/question to a person. */
const OWNER_CHANNELS = ["discord", "signal", "slack", "telegram", "whatsapp"] as const;

/** The empty-roster fallback: before anyone (including the owner) has a channel identity on file,
 *  `teamPanel` falls back to this form so the very first person can tell Vasu where to reach them.
 *  Once `team.get` returns at least one member, this is never shown again. */
function ownerSettingsForm(): string {
  const options = OWNER_CHANNELS.map(
    (channel) => `<option value="${channel}">${channel}</option>`,
  ).join("");
  return `<div class="ownerform"><label class="fld"><span>Channel</span><select data-settings-channel>${options}</select></label><label class="fld"><span>Target</span><input type="text" data-settings-target placeholder="chat id, phone, @handle"></label><button class="btn primary" data-settings-save>Save</button></div>`;
}

/** The browser bundle's own structural view of `team.get`'s reply. A read-level caller gets every
 *  field except a channel's `senderId`, which `team.get` itself withholds below admin scope;
 *  `canAdmin` gating below is the matching display choice.
 *
 *  `accountId` is carried even though nothing here renders it: `addTeamChannel` rebuilds the whole
 *  identity list from this view, and dropping the field there would silently widen an
 *  account-scoped routing match to `"*"`. */
type TeamMemberView = {
  id: string;
  name: string;
  role: "owner" | "member";
  channels: Array<{ channel: string; senderId?: string; accountId?: string }>;
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
  const actions =
    canAdmin && member.role !== "owner"
      ? `<button class="btn" data-team-transfer="${esc(member.id)}">Make owner</button>` +
        `<button class="btn" data-team-remove="${esc(member.id)}">Remove</button>`
      : "";
  const addChannel = canAdmin
    ? `<span class="taddchan"><select data-team-row-channel="${esc(member.id)}">${OWNER_CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select>` +
      `<input type="text" data-team-row-sender="${esc(member.id)}" placeholder="their id on that channel">` +
      `<button class="btn" data-team-channel-add="${esc(member.id)}">Add a channel</button></span>`
    : "";
  return `<div class="teamrow"><span class="tname">${esc(member.name)}</span><span class="trole">${role}</span><span class="tchans">${channels}</span><span class="tacts">${actions}${addChannel}</span></div>`;
}

/** The whole content of the Team page — its own top-level sidebar item. Hiding the mutating
 *  controls without admin scope is cosmetic: `team.*` writes are gated at `operator.admin`
 *  server-side, which is the actual authority check. `opts` follows the same trailing-`RenderOpts`
 *  convention every page-level render function in this codebase uses, so a failed
 *  add/remove/transfer surfaces through the same error-banner-plus-`data-retry` shape. */
export function teamPanel(
  view: TeamView | undefined,
  canAdmin: boolean,
  opts?: RenderOpts,
): string {
  const errorBanner = opts?.error ? renderErrorBanner(opts.error) : "";
  if (!view) {
    return `${errorBanner}<div><h3>Team</h3><p class="muted small">Loading…</p></div>`;
  }
  if (view.members.length === 0) {
    return `${errorBanner}<div><h3>Team</h3><p class="muted small">Tell Vasu where to reach you. That makes you the first person on the Team.</p>${ownerSettingsForm()}</div>`;
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
  return `${errorBanner}<div><h3>Team</h3><p class="muted small">Who Vasu takes instructions from. Everyone here can reach Vasu on the channels listed.</p>${warnings}<div class="teamlist">${rows}</div>${add}</div>`;
}
