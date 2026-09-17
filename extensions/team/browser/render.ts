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

export type RenderOpts = { error?: string; pending?: readonly TeamPendingRequestView[] };

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

/** The browser bundle's own structural view of one `channels.pairing.list` request
 *  (`packages/gateway-protocol/src/schema/channel-pairing.ts`'s `ChannelsPairingRequest`) — only the
 *  fields the "waiting to be added" prompt needs: enough to label the person and to hand straight
 *  back to `team.add` as one `{ channel, senderId, accountId }` identity, unchanged. */
export type TeamPendingRequestView = {
  requestId: string;
  channel: string;
  channelLabel: string;
  accountId: string;
  senderId: string;
  metadata?: Record<string, string>;
};

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

/** Best display name for a pending pairing request: channel plugins that capture a name at
 *  challenge time (`extensions/whatsapp/src/inbound/access-control.ts`'s `meta.name` from the
 *  WhatsApp push name, `extensions/telegram/src/dm-access.ts`'s `meta.firstName`/`lastName`) put it
 *  in `metadata`; a channel that captures none falls back to the id itself, same as `senderLabel`
 *  would describe it. */
function pendingRequestName(request: TeamPendingRequestView): string {
  const meta = request.metadata ?? {};
  const fullName = [meta.firstName, meta.lastName].filter(Boolean).join(" ");
  return meta.name || fullName || meta.username || request.senderId;
}

/** One `data-team-add-pending` button per pending request, carrying the whole identity it would
 *  add — name, channel, account and sender id — as its own `data-pending-*` attributes, so the
 *  click handler needs no lookup back into a list by `requestId`: the button IS the identity. */
function pendingRow(request: TeamPendingRequestView): string {
  const name = pendingRequestName(request);
  return (
    `<div class="pendingrow">` +
    `<span class="tname">${esc(name)}</span>` +
    `<span class="muted small">${esc(request.senderId)} · ${esc(request.channelLabel)}</span>` +
    `<button class="btn primary" data-team-add-pending` +
    ` data-pending-name="${esc(name)}"` +
    ` data-pending-channel="${esc(request.channel)}"` +
    ` data-pending-account="${esc(request.accountId)}"` +
    ` data-pending-sender="${esc(request.senderId)}">Add to Team</button>` +
    `</div>`
  );
}

/** "Ashu (+91…) is waiting — add to Team?": one click picks a real pending requester instead of the
 *  owner typing a number from memory, and folds `channels.pairing.approve` into that same
 *  `team.add` call (`gateway-methods.ts`'s `approvePendingPairingRequests`) — never a bare pairing
 *  approval that admits someone the roster never named. Empty when there is nothing pending, so it
 *  adds no chrome to the common case. */
function pendingSection(pending: readonly TeamPendingRequestView[]): string {
  if (pending.length === 0) {
    return "";
  }
  return (
    `<div class="teampending"><h3 class="small muted">Waiting — add them to Team?</h3>` +
    pending.map(pendingRow).join("") +
    `</div>`
  );
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
  // Read-level callers never see this: `channels.pairing.list` carries raw sender ids, the same PII
  // `team.get` itself withholds below admin scope, and the button it feeds only `team.add`, an
  // admin-only write.
  const pending = canAdmin ? pendingSection(opts?.pending ?? []) : "";
  const add = canAdmin
    ? `<div class="teamadd"><label class="fld"><span>Name</span><input type="text" data-team-name placeholder="Ramesh"></label>` +
      `<label class="fld"><span>Channel</span><select data-team-channel>${OWNER_CHANNELS.map((c) => `<option value="${c}">${c}</option>`).join("")}</select></label>` +
      `<label class="fld"><span>Their id on that channel</span><input type="text" data-team-sender placeholder="chat id, phone, @handle"></label>` +
      `<button class="btn primary" data-team-add>Add someone</button></div>`
    : "";
  return `${errorBanner}<div><h3>Team</h3><p class="muted small">Who Vasu takes instructions from. Everyone here can reach Vasu on the channels listed.</p>${warnings}${pending}<div class="teamlist">${rows}</div>${add}</div>`;
}
