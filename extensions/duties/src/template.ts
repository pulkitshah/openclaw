import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type TemplateSlot = {
  name: string;
  kind: "text" | "rows" | "prose";
  description: string;
  columns?: string[];
};
export type Template = {
  id: string;
  name: string;
  kind: "pdf" | "message";
  /** For `pdf`: an HTML document body; for `message`: plain text. Slots use {{slot:name}},
   *  rows use {{#rows:name}}…{{col:column}}…{{/rows:name}}, brand fields {{brand:field}}. */
  html: string;
  slots: TemplateSlot[];
  updatedAt: number;
};
export type Brand = {
  name: string;
  logoDataUrl?: string;
  primary?: string;
  accent?: string;
  phone?: string;
  email?: string;
  footer?: string;
  updatedAt: number;
};

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NAME_RE = /^[A-Za-z0-9_-]+$/u;
const SLOT_RE = /\{\{slot:([A-Za-z0-9_-]+)\}\}/gu;
const ROWS_RE = /\{\{#rows:([A-Za-z0-9_-]+)\}\}([\s\S]*?)\{\{\/rows:\1\}\}/gu;
const COL_RE = /\{\{col:([A-Za-z0-9_-]+)\}\}/gu;
const BRAND_RE = /\{\{brand:(name|logoDataUrl|primary|accent|phone|email|footer)\}\}/gu;
const BRAND_FIELDS = [
  "name",
  "logoDataUrl",
  "primary",
  "accent",
  "phone",
  "email",
  "footer",
] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function validateTemplate(
  input: unknown,
): { ok: true; template: Template } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["template must be an object"] };
  if (typeof input.id !== "string" || !ID_RE.test(input.id))
    errors.push("id must be a kebab-case slug");
  if (typeof input.name !== "string" || !input.name.trim()) errors.push("name is required");
  if (input.kind !== "pdf" && input.kind !== "message") errors.push("kind must be pdf or message");
  if (typeof input.html !== "string" || !input.html.trim()) errors.push("html is required");
  if (typeof input.updatedAt !== "number") errors.push("updatedAt must be a number");
  const declared = new Map<string, TemplateSlot>();
  if (!Array.isArray(input.slots)) errors.push("slots must be an array");
  else {
    input.slots.forEach((slot, idx) => {
      if (!isRecord(slot) || typeof slot.name !== "string" || !NAME_RE.test(slot.name)) {
        errors.push(`slots[${idx}]: name must match ${NAME_RE.source}`);
        return;
      }
      if (slot.kind !== "text" && slot.kind !== "rows" && slot.kind !== "prose")
        errors.push(`slot "${slot.name}": kind must be text, rows or prose`);
      if (typeof slot.description !== "string")
        errors.push(`slot "${slot.name}": description is required`);
      if (
        slot.kind === "rows" &&
        (!Array.isArray(slot.columns) ||
          slot.columns.length === 0 ||
          slot.columns.some((c) => typeof c !== "string" || !NAME_RE.test(c)))
      )
        errors.push(`slot "${slot.name}": rows slots need at least one column`);
      if (declared.has(slot.name)) errors.push(`slot "${slot.name}" is declared twice`);
      // SAFETY: name, kind, description and (for rows) columns were checked above; a failing check already pushed an error.
      declared.set(slot.name, slot as unknown as TemplateSlot);
    });
  }
  if (typeof input.html === "string") {
    const html = input.html;
    const slotRefs = new Set<string>();
    for (const m of html.matchAll(SLOT_RE)) if (m[1]) slotRefs.add(m[1]);
    const rowsMatches = [...html.matchAll(ROWS_RE)];
    const rowsRefs = new Set<string>();
    for (const m of rowsMatches) if (m[1]) rowsRefs.add(m[1]);

    for (const name of slotRefs) {
      const slot = declared.get(name);
      if (!slot) errors.push(`html uses undeclared slot "${name}"`);
      else if (slot.kind === "rows")
        errors.push(`slot "${name}" is a rows slot: use {{#rows:${name}}}…{{/rows:${name}}}`);
    }
    for (const name of rowsRefs) {
      const slot = declared.get(name);
      if (!slot) errors.push(`html uses undeclared slot "${name}"`);
      else if (slot.kind !== "rows")
        errors.push(`slot "${name}" is not a rows slot: use {{slot:${name}}}`);
    }
    for (const name of declared.keys())
      if (!slotRefs.has(name) && !rowsRefs.has(name))
        errors.push(`slot "${name}" is declared but not used in html`);

    for (const m of rowsMatches) {
      const name = m[1];
      const slot = name ? declared.get(name) : undefined;
      if (slot?.kind !== "rows") continue;
      const body = m[2] ?? "";
      for (const cm of body.matchAll(COL_RE)) {
        const col = cm[1];
        if (col && !(slot.columns ?? []).includes(col))
          errors.push(`rows slot "${name}" has no column "${col}"`);
      }
    }
    for (const cm of html.replaceAll(ROWS_RE, "").matchAll(COL_RE))
      errors.push(`${cm[0]} is only valid inside a rows block`);
  }
  if (errors.length) return { ok: false, errors };
  // SAFETY: every Template field (id, name, kind, html, updatedAt, slots) was validated above.
  return { ok: true, template: input as unknown as Template };
}

export function validateBrand(
  input: unknown,
): { ok: true; brand: Brand } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["brand must be an object"] };
  if (typeof input.name !== "string" || !input.name.trim()) errors.push("name is required");
  for (const field of BRAND_FIELDS) {
    if (field === "name") continue;
    if (input[field] !== undefined && typeof input[field] !== "string")
      errors.push(`${field} must be a string`);
  }
  if (
    typeof input.logoDataUrl === "string" &&
    input.logoDataUrl &&
    !input.logoDataUrl.startsWith("data:image/")
  )
    errors.push("logoDataUrl must be a data:image/... URL");
  // 700,000 base64 characters ≈ 512 KB of decoded image bytes — matches the client-side cap in
  // `browser/index.ts`'s `saveBrand`, applied here too since this is the RPC's only real gate.
  if (typeof input.logoDataUrl === "string" && input.logoDataUrl.length > 700_000)
    errors.push("logoDataUrl is too large (max 512 KB image)");
  if (typeof input.updatedAt !== "number") errors.push("updatedAt must be a number");
  if (errors.length) return { ok: false, errors };
  // SAFETY: name, every optional string field, logoDataUrl's shape and updatedAt were validated above.
  return { ok: true, brand: input as unknown as Brand };
}

/** Deterministic substitution: no logic, no partial output. Every declared slot must be present
 *  (text/prose: non-empty string; rows: array of objects) or the render reports it as missing. */
export function renderTemplate(
  template: Template,
  data: Record<string, unknown>,
  brand?: Brand,
): { ok: true; output: string } | { ok: false; missing: string[] } {
  const esc = template.kind === "pdf" ? escapeHtml : (s: string) => s;
  const missing: string[] = [];
  const text = new Map<string, string>();
  const rows = new Map<string, Array<Record<string, unknown>>>();
  for (const slot of template.slots) {
    const value = data[slot.name];
    if (slot.kind === "rows") {
      if (Array.isArray(value) && value.every(isRecord)) {
        const cols = slot.columns ?? [];
        const missingCols = cols.filter((col) =>
          value.some((row) => row[col] === undefined || row[col] === null),
        );
        if (missingCols.length) for (const col of missingCols) missing.push(`${slot.name}.${col}`);
        else rows.set(slot.name, value);
      } else missing.push(slot.name);
    } else if (typeof value === "string" && value.trim()) text.set(slot.name, value);
    else if (typeof value === "number") text.set(slot.name, String(value));
    else missing.push(slot.name);
  }
  if (missing.length) return { ok: false, missing };
  let output = template.html.replaceAll(ROWS_RE, (_whole, name: string, body: string) =>
    (rows.get(name) ?? [])
      .map((row) => body.replaceAll(COL_RE, (_c, col: string) => esc(stringifyCell(row[col]))))
      .join(""),
  );
  output = output.replaceAll(SLOT_RE, (_whole, name: string) => esc(text.get(name) ?? ""));
  output = output.replaceAll(BRAND_RE, (_whole, field: (typeof BRAND_FIELDS)[number]) => {
    if (field === "logoDataUrl") {
      const logo = brand?.logoDataUrl;
      return typeof logo === "string" && logo.startsWith("data:image/") ? logo : "";
    }
    return esc(brand?.[field] ?? "");
  });
  return { ok: true, output };
}

function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : JSON.stringify(value);
}

/** `[name]` for text/prose slots and one `[column]` row for rows slots — enough for a preview. */
export function placeholderData(template: Template): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const slot of template.slots) {
    data[slot.name] =
      slot.kind === "rows"
        ? [Object.fromEntries((slot.columns ?? []).map((c) => [c, `[${c}]`]))]
        : `[${slot.name}]`;
  }
  return data;
}
