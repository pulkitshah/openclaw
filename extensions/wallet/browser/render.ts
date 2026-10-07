// Pure render functions for the Wallet Control UI page. No DOM access: `wallet-page.ts` owns the
// host wiring and assigns these strings to `innerHTML`. This bundle is built independently of the
// plugin's runtime, so the few helpers it shares with `../src/money.ts` (`formatInr`) are copied
// here rather than runtime-imported; only types come from `../src`.
import { modelDisplayName } from "../src/model-names.js";
import type { RateCard } from "../src/money.js";
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
  rateCard: RateCard;
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
  const limit =
    get.state.creditLimitPaise > 0
      ? `<span class="wallet-limit muted small">limit ${esc(formatRupees(get.state.creditLimitPaise))}</span>`
      : "";
  return `<section class="wallet-head"><div><div class="wallet-label">Balance</div><div class="wallet-balance mono">${esc(formatInr(get.balancePaise))}</div>${limit}</div><div class="wallet-meta">${stateChip(get)}${days}${recharge}</div></section>`;
}

/** Whole rupees without paise when there are none: "₹5,000", "₹12.50". The balance header is the
 *  only place a signed amount is shown. */
function formatRupees(paise: number): string {
  const text = formatInr(paise);
  return text.endsWith(".00") ? text.slice(0, -3) : text;
}

/** Debits are stored negative; buckets, activities and drill-down rows show spend as positive. */
const spend = (paise: number): number => -paise;

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
  const total = Math.abs(summary.totalPaise) || 1;
  const rows = summary.buckets
    .map((bucket) => {
      const share = Math.min(100, Math.max(0, Math.round((Math.abs(bucket.paise) / total) * 100)));
      return `<button class="bucket${bucket.activity === open ? " open" : ""}" data-bucket="${esc(bucket.activity)}"><span class="bname">${esc(BUCKET_LABELS[bucket.activity])}</span><span class="bamt mono">${esc(formatInr(spend(bucket.paise)))}</span><span class="bbar"><span class="bfill" style="width:${share}%"></span></span><span class="bshare muted small">${share}%</span></button>`;
    })
    .join("");
  return `<div class="buckets">${rows}</div>`;
}

/** Tokens as "950", "12.3 K" or "38.7 M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)} M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)} k`;
  }
  return String(n);
}

/** The "By model" rows under the buckets; empty when no token debits carry a model. */
export function renderModels(summary: Summary): string {
  // Optional chaining: a page bundle can briefly meet a Gateway still answering without `models`.
  if (!summary.models?.length) {
    return "";
  }
  const total = summary.models.reduce((sum, m) => sum + Math.abs(m.paise), 0) || 1;
  const rows = summary.models
    .map((m) => {
      const share = Math.min(100, Math.max(0, Math.round((Math.abs(m.paise) / total) * 100)));
      const unpriced = m.unpriced ? ` <span class="warn-text">(not in rate card)</span>` : "";
      return `<div class="modelrow"><span class="mname">${esc(m.label)} <span class="chip mchip">${esc(m.provider)}</span>${unpriced}</span><span class="bamt mono">${esc(formatInr(spend(m.paise)))}</span><span class="bbar"><span class="bfill" style="width:${share}%"></span></span><span class="bshare muted small">${share}%</span><span class="mmeta muted small">${esc(formatTokens(m.tokens))} tokens · ${esc(m.calls)} ${m.calls === 1 ? "call" : "calls"}</span></div>`;
    })
    .join("");
  return `<h2>By model</h2><div class="buckets models">${rows}</div>`;
}

export function renderActivities(bucket: Bucket, openRef: string | undefined): string {
  if (bucket.activities.length === 0) {
    return `<p class="muted small">No detail for ${esc(BUCKET_LABELS[bucket.activity])}.</p>`;
  }
  const rows = bucket.activities
    .map(
      (item) =>
        `<button class="activity${item.ref === openRef ? " open" : ""}" data-activity="${esc(item.ref)}"><span class="aname">${esc(item.label)}</span><span class="muted small">${esc(item.entries)} ${item.entries === 1 ? "call" : "calls"}</span><span class="mono">${esc(formatInr(spend(item.paise)))}</span></button>`,
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
        `<div class="entry"><span class="muted small mono">${esc(formatIstDateTime(entry.at))}</span><span>${esc(entry.label)}</span><span class="muted small">${esc(entryTokens(entry))}</span><span class="mono">${esc(formatInr(spend(entry.amountPaise)))}</span></div>`,
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

/** Model (friendly name plus a provider chip) or service name; blank for credits and adjustments. */
function statementModel(entry: WalletEntry): string {
  if (entry.kind !== "debit") {
    return "";
  }
  if (entry.charge === "tokens") {
    return `${esc(modelDisplayName(entry.provider, entry.model))} <span class="chip mchip">${esc(entry.provider)}</span>`;
  }
  return esc(entry.service);
}

function statementTokens(entry: WalletEntry): string {
  if (entry.kind !== "debit" || entry.charge !== "tokens") {
    return "";
  }
  return formatTokens(
    entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens,
  );
}

export function renderStatement(entries: readonly WalletEntry[], hasMore = false): string {
  const rows = entries
    .map(
      (entry) =>
        `<tr class="${entry.kind}"><td class="mono small">${esc(formatIstDateTime(entry.at))}</td><td class="what">${esc(entry.label)}</td><td class="smodel small">${statementModel(entry)}</td><td class="stokens mono small num">${esc(statementTokens(entry))}</td><td class="muted small snote">${esc(statementNote(entry))}</td><td class="mono num">${esc(formatInr(entry.amountPaise))}</td><td class="mono num muted">${esc(formatInr(entry.balanceAfterPaise))}</td></tr>`,
    )
    .join("");
  const table =
    entries.length === 0
      ? `<p class="muted">No entries in this period.</p>`
      : `<table class="statement"><thead><tr><th>When (IST)</th><th>What</th><th>Model</th><th class="num">Tokens</th><th>Note</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead><tbody>${rows}</tbody></table>`;
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
  const backfill =
    get.state.backfillDoneAt === undefined
      ? `<button class="btn" data-backfill>Import past usage</button>`
      : "";
  return `<section class="admin"><div class="adminbar">${tab("recharge", "Recharge")}${tab("adjust", "Adjust")}${tab("settings", "Settings")}${backfill}</div>${renderAdminFacts(get)}${form}</section>`;
}

function rateCardLine(card: RateCard): string {
  const hosting = card.services.hosting;
  const hostingText =
    hosting && hosting.inrPerUnit > 0
      ? `hosting ₹${hosting.inrPerUnit}/${hosting.unit}`
      : "hosting off";
  const fallback = card.aliases.default ?? "built-in";
  return `₹${card.inrPerUsd}/USD × ${card.multiplier}; fallback ${fallback}; ${hostingText}`;
}

/** What TripIn Studio checks before acting: limit, effective card, backfill status, lost debits. */
function renderAdminFacts(get: WalletGet): string {
  const { state } = get;
  const facts = [
    `<li>Credit limit <span class="mono">${esc(formatRupees(state.creditLimitPaise))}</span> · low-balance notice at <span class="mono">${esc(formatRupees(state.lowBalancePaise))}</span> · contact ${esc(get.contact)}</li>`,
    `<li>Rate card <span class="mono">${esc(rateCardLine(get.rateCard))}</span></li>`,
  ];
  if (state.backfillDoneAt !== undefined) {
    facts.push(`<li>Imported past usage on ${esc(formatIstDate(state.backfillDoneAt))}</li>`);
  }
  if (get.unrecorded > 0) {
    facts.push(
      `<li class="unrecorded">${esc(get.unrecorded)} ${get.unrecorded === 1 ? "debit" : "debits"} not recorded — tell ${esc(get.contact)}</li>`,
    );
  }
  return `<ul class="adminfacts small">${facts.join("")}</ul>`;
}

export function renderNotice(text: string): string {
  return `<div class="notice">${esc(text)}</div>`;
}
