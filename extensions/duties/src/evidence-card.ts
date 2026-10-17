import { escapeHtml as esc } from "./template.js";

/** What a step with no browser tab is pictured by: its own record of what it did. Every value has
 *  already been through the runner's `redact`, so a card never shows a credential. */
export type EvidenceCard = {
  label: string;
  kind: string;
  status: "ok" | "failed" | "blocked";
  summary: string;
  /** What the step produced (its saved outputs), already serialized and redacted. */
  produced?: string;
};

/** Past this the card is cut: it is a picture of one screen, and the full outputs stay in the
 *  run record. */
const PRODUCED_LIMIT = 2_400;

const STATUS_TEXT: Record<EvidenceCard["status"], string> = {
  ok: "Done",
  failed: "Failed",
  blocked: "Blocked",
};

/** A self-contained page (no external assets: the render tab may have no network) sized to one
 *  viewport, so a plain viewport screenshot captures all of it. */
export function evidenceCardHtml(card: EvidenceCard): string {
  const produced =
    card.produced && card.produced.length > PRODUCED_LIMIT
      ? `${card.produced.slice(0, PRODUCED_LIMIT)}\n…`
      : card.produced;
  return `<html><head><meta charset="utf-8"><title>${esc(card.label)}</title><style>
body{margin:0;padding:32px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f7f7f5;color:#1c1c1a}
.card{background:#fff;border:1px solid #e3e2dc;border-radius:12px;padding:24px 28px;max-width:960px}
.top{display:flex;gap:10px;align-items:center;margin-bottom:8px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#6b6a63}
.st{padding:2px 8px;border-radius:999px;font-weight:600}
.st.ok{background:#e7f6ec;color:#1d7a3e}.st.failed,.st.blocked{background:#fdecec;color:#b42318}
h1{font-size:20px;margin:0 0 12px}
.sum{margin:0 0 16px;white-space:pre-wrap;word-break:break-word}
pre{margin:0;padding:14px 16px;background:#f2f1ec;border-radius:8px;font:12px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.lbl{font-size:12px;color:#6b6a63;margin-bottom:6px}
</style></head><body><div class="card"><div class="top"><span>${esc(card.kind)} step</span><span class="st ${card.status}">${STATUS_TEXT[card.status]}</span></div>
<h1>${esc(card.label)}</h1>${card.summary ? `<p class="sum">${esc(card.summary)}</p>` : ""}${
    produced ? `<div class="lbl">Produced</div><pre>${esc(produced)}</pre>` : ""
  }</div></body></html>`;
}
