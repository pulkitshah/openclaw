// Pure render functions for the Wallet Control UI page. No DOM access: `wallet-page.ts` owns the
// host wiring and assigns these strings to `innerHTML`. This bundle is built independently of the
// plugin's runtime, so the few helpers it shares with `../src/money.ts` (`formatInr`) are copied
// here rather than runtime-imported; only types come from `../src`.
import type { Activity, Summary, WalletEntry, WalletState } from "../src/store.js";

export type Period = "today" | "month" | "30d" | "custom";

/** The page's own narrow view of `wallet.get`'s reply (the gateway-side reader omits `period`). */
export type WalletGet = {
  balancePaise: number;
  state: WalletState;
  daysLeft: number | null;
  period: { from: number; to: number };
  summary: Summary;
  contact: string;
  unrecorded: number;
  rateCard: unknown;
};

export type WalletForm = "recharge" | "adjust" | "settings";
type Bucket = Summary["buckets"][number];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function esc(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Same output as `formatInr` in `src/money.ts`: rupee sign, Indian grouping, two decimals. */
export function formatInr(paise: number): string {
  const sign = paise < 0 ? "−" : "";
  const abs = Math.abs(paise);
  const s = String(Math.floor(abs / 100));
  const p = String(abs % 100).padStart(2, "0");
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `₹${sign}${grouped}.${p}`;
}

/** Rupees as typed into a form field: whole rupees without decimals. */
export function paiseToRupeeText(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

export function formatIstDate(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function formatIstDateTime(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${formatIstDate(ms)}, ${hh}:${mm}`;
}

const BUCKET_LABELS: Record<Activity, string> = {
  chat: "Chats",
  duty: "Duties",
  mail: "Mail",
  system: "System",
  hosting: "Hosting",
  integration: "Integrations",
};

export function renderErrorBanner(message: string): string {
  return `<div class="error"><span>${esc(message)}</span><button class="btn" data-retry>Retry</button></div>`;
}

function stateChip(get: WalletGet): string {
  const { state, balancePaise } = get;
  if (state.stoppedSince) {
    return `<span class="chip bad">Paused since ${esc(formatIstDate(state.stoppedSince))}</span>`;
  }
  if (state.enforce && balancePaise + state.creditLimitPaise <= state.lowBalancePaise) {
    return `<span class="chip warn">Low</span>`;
  }
  return `<span class="chip ok">Active</span>`;
}

/** The one place the brand gradient is spent on this page. */
export function renderHeader(get: WalletGet, canAdmin: boolean): string {
  const days =
    get.daysLeft === null
      ? ""
      : `<span class="muted small">About ${esc(get.daysLeft)} ${get.daysLeft === 1 ? "day" : "days"} left at the recent pace</span>`;
  const recharge = canAdmin
    ? ""
    : `<p class="small muted">To recharge, ask ${esc(get.contact)}.</p>`;
  return `<section class="wallet-head"><div><div class="wallet-label">Balance</div><div class="wallet-balance mono">${esc(formatInr(get.balancePaise))}</div></div><div class="wallet-meta">${stateChip(get)}${days}${recharge}</div></section>`;
}

const PERIODS: Array<[Period, string]> = [
  ["today", "Today"],
  ["month", "This month"],
  ["30d", "Last 30 days"],
  ["custom", "Custom"],
];

function dateInputValue(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

export function renderPeriodBar(period: Period, range: { from: number; to: number }): string {
  const buttons = PERIODS.map(
    ([id, label]) =>
      `<button class="btn${id === period ? " primary" : ""}" data-period="${id}">${label}</button>`,
  ).join("");
  const custom =
    period === "custom"
      ? `<label class="fld inline"><span>From</span><input type="date" data-custom-from value="${dateInputValue(range.from)}"></label><label class="fld inline"><span>To</span><input type="date" data-custom-to value="${dateInputValue(range.to)}"></label><button class="btn" data-custom-apply>Apply</button>`
      : "";
  return `<div class="periodbar">${buttons}${custom}</div>`;
}

export function renderBuckets(summary: Summary, open: Activity | undefined): string {
  if (summary.buckets.length === 0) {
    return `<p class="muted">Nothing has been spent in this period.</p>`;
  }
  const total = summary.totalPaise > 0 ? summary.totalPaise : 1;
  const rows = summary.buckets
    .map((bucket) => {
      const share = Math.round((bucket.paise / total) * 100);
      return `<button class="bucket${bucket.activity === open ? " open" : ""}" data-bucket="${esc(bucket.activity)}"><span class="bname">${esc(BUCKET_LABELS[bucket.activity])}</span><span class="bamt mono">${esc(formatInr(bucket.paise))}</span><span class="bbar"><span class="bfill" style="width:${share}%"></span></span><span class="bshare muted small">${share}%</span></button>`;
    })
    .join("");
  return `<div class="buckets">${rows}</div>`;
}

export function renderActivities(bucket: Bucket, openRef: string | undefined): string {
  if (bucket.activities.length === 0) {
    return `<p class="muted small">No detail for ${esc(BUCKET_LABELS[bucket.activity])}.</p>`;
  }
  const rows = bucket.activities
    .map(
      (item) =>
        `<button class="activity${item.ref === openRef ? " open" : ""}" data-activity="${esc(item.ref)}"><span class="aname">${esc(item.label)}</span><span class="muted small">${esc(item.entries)} ${item.entries === 1 ? "call" : "calls"}</span><span class="mono">${esc(formatInr(item.paise))}</span></button>`,
    )
    .join("");
  return `<div class="activities">${rows}</div>`;
}

function entryTokens(entry: WalletEntry): string {
  if (entry.kind !== "debit") {
    return "";
  }
  if (entry.charge === "tokens") {
    const n =
      entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens;
    return `${n} tokens`;
  }
  return `${entry.units} ${entry.unit}`;
}

export function renderEntries(entries: readonly WalletEntry[]): string {
  if (entries.length === 0) {
    return `<p class="muted small">No entries.</p>`;
  }
  const rows = entries
    .map(
      (entry) =>
        `<div class="entry"><span class="muted small mono">${esc(formatIstDateTime(entry.at))}</span><span>${esc(entry.label)}</span><span class="muted small">${esc(entryTokens(entry))}</span><span class="mono">${esc(formatInr(entry.amountPaise))}</span></div>`,
    )
    .join("");
  return `<div class="entries">${rows}</div>`;
}

function statementNote(entry: WalletEntry): string {
  if (entry.kind === "credit") {
    return entry.reference;
  }
  return entry.note ?? "";
}

export function renderStatement(entries: readonly WalletEntry[], hasMore = false): string {
  const rows = entries
    .map(
      (entry) =>
        `<tr class="${entry.kind}"><td class="mono small">${esc(formatIstDateTime(entry.at))}</td><td>${esc(entry.label)}</td><td class="muted small">${esc(statementNote(entry))}</td><td class="mono num">${esc(formatInr(entry.amountPaise))}</td><td class="mono num muted">${esc(formatInr(entry.balanceAfterPaise))}</td></tr>`,
    )
    .join("");
  const table =
    entries.length === 0
      ? `<p class="muted">No entries in this period.</p>`
      : `<table class="statement"><thead><tr><th>When (IST)</th><th>What</th><th>Note</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead><tbody>${rows}</tbody></table>`;
  const more = hasMore ? `<button class="btn" data-more>Load more</button>` : "";
  return `<div class="stmthead"><h2>Statement</h2><button class="btn" data-export>Export CSV</button></div>${table}${more}`;
}

function field(
  label: string,
  attr: string,
  opts: { value?: string; placeholder?: string; type?: string; step?: string; min?: string } = {},
): string {
  return `<label class="fld"><span>${esc(label)}</span><input type="${opts.type ?? "text"}" ${attr}${opts.step ? ` step="${opts.step}"` : ""}${opts.min ? ` min="${opts.min}"` : ""} value="${esc(opts.value ?? "")}" placeholder="${esc(opts.placeholder ?? "")}"></label>`;
}

function formBody(get: WalletGet, form: WalletForm): string {
  if (form === "recharge") {
    return `${field("Amount (₹)", "data-f-amount", { placeholder: "5000", type: "number", step: "0.01", min: "0.01" })}${field("Reference", "data-f-reference", { placeholder: "UPI or bank reference" })}${field("Note (optional)", "data-f-note")}<button class="btn primary" data-submit="recharge">Add recharge</button>`;
  }
  if (form === "adjust") {
    return `${field("Amount (₹, negative to deduct)", "data-f-amount", { type: "number", step: "0.01" })}${field("Note", "data-f-note", { placeholder: "Why this adjustment" })}<button class="btn primary" data-submit="adjust">Apply adjustment</button>`;
  }
  const { state } = get;
  return `${field("Credit limit (₹)", "data-f-limit", { value: paiseToRupeeText(state.creditLimitPaise), type: "number", step: "0.01", min: "0" })}${field("Low-balance notice at (₹)", "data-f-low", { value: paiseToRupeeText(state.lowBalancePaise), type: "number", step: "0.01", min: "0" })}<label class="fld check"><input type="checkbox" data-f-enforce${state.enforce ? " checked" : ""}> <span>Pause the desk when the balance and credit limit run out</span></label><button class="btn primary" data-submit="settings">Save settings</button>`;
}

/** Cosmetic gate: `wallet.*` writes are admin-scoped server-side; without `canAdmin` nothing draws. */
export function renderAdmin(
  get: WalletGet,
  openForm: WalletForm | undefined,
  canAdmin: boolean,
): string {
  if (!canAdmin) {
    return "";
  }
  const tab = (id: WalletForm, label: string) =>
    `<button class="btn${openForm === id ? " primary" : ""}" data-open-form="${id}">${label}</button>`;
  const form = openForm ? `<div class="adminform">${formBody(get, openForm)}</div>` : "";
  return `<section class="admin"><div class="adminbar">${tab("recharge", "Recharge")}${tab("adjust", "Adjust")}${tab("settings", "Settings")}<button class="btn" data-backfill>Import past usage</button></div>${form}</section>`;
}

export function renderNotice(text: string): string {
  return `<div class="notice">${esc(text)}</div>`;
}
