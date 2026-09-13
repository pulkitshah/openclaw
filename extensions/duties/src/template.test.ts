import { describe, expect, it } from "vitest";
import {
  placeholderData,
  renderTemplate,
  validateBrand,
  validateTemplate,
  type Template,
} from "./template.js";

const tpl: Template = {
  id: "flight-options",
  name: "Flight options",
  kind: "pdf",
  updatedAt: 1,
  html: `<h1>{{brand:name}}</h1><p>{{slot:route}} on {{slot:date}}</p><table>{{#rows:flights}}<tr><td>{{col:airline}}</td><td>{{col:fare}}</td></tr>{{/rows:flights}}</table><p>{{slot:notes}}</p>`,
  slots: [
    { name: "route", kind: "text", description: "From → To" },
    { name: "date", kind: "text", description: "Travel date" },
    {
      name: "flights",
      kind: "rows",
      description: "One row per option",
      columns: ["airline", "fare"],
    },
    { name: "notes", kind: "prose", description: "Short advice" },
  ],
};

describe("validateTemplate", () => {
  it("requires every html placeholder to be declared and every slot to be used", () => {
    const r = validateTemplate({ ...tpl, html: "{{slot:route}} {{slot:ghost}}" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain('html uses undeclared slot "ghost"');
      expect(r.errors).toContain('slot "date" is declared but not used in html');
    }
  });
  it("requires columns on rows slots and a kebab-case id", () => {
    const r = validateTemplate({
      ...tpl,
      id: "Flight Options",
      slots: tpl.slots.map((s) => (s.kind === "rows" ? { ...s, columns: [] } : s)),
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors).toEqual(
        expect.arrayContaining([
          "id must be a kebab-case slug",
          'slot "flights": rows slots need at least one column',
        ]),
      );
  });
});

describe("renderTemplate", () => {
  it("substitutes text, rows, prose and brand, escaping html in pdf templates", () => {
    const r = renderTemplate(
      tpl,
      {
        route: "IXU → COK",
        date: "02 Oct 2026",
        flights: [{ airline: "IndiGo <6E>", fare: "₹27,772" }],
        notes: "Agency fare",
      },
      { name: "Amigos & Co", updatedAt: 1 },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain("<h1>Amigos &amp; Co</h1>");
      expect(r.output).toContain("<td>IndiGo &lt;6E&gt;</td><td>₹27,772</td>");
      expect(r.output).not.toContain("{{");
    }
  });
  it("reports every unfilled slot instead of rendering blanks", () => {
    const r = renderTemplate(tpl, { route: "x", flights: "not an array" });
    expect(r).toEqual({ ok: false, missing: ["date", "flights", "notes"] });
  });
  it("message templates are not html-escaped", () => {
    const m: Template = {
      ...tpl,
      kind: "message",
      html: "Options for {{slot:route}}",
      slots: [tpl.slots[0]!],
    };
    const r = renderTemplate(m, { route: "A & B" });
    expect(r).toEqual({ ok: true, output: "Options for A & B" });
  });
  it("placeholderData fills every slot with a sample", () => {
    const d = placeholderData(tpl);
    expect(d.route).toBe("[route]");
    expect(d.flights).toEqual([{ airline: "[airline]", fare: "[fare]" }]);
    expect(renderTemplate(tpl, d).ok).toBe(true);
  });

  it("only emits {{brand:logoDataUrl}} when it is a data:image/ URL", () => {
    const t: Template = { ...tpl, html: '<img src="{{brand:logoDataUrl}}">', slots: [] };
    const bad = renderTemplate(
      t,
      {},
      { name: "Acme", logoDataUrl: "javascript:alert(1)", updatedAt: 1 },
    );
    expect(bad).toEqual({ ok: true, output: '<img src="">' });
    const good = renderTemplate(
      t,
      {},
      { name: "Acme", logoDataUrl: "data:image/png;base64,AAA", updatedAt: 1 },
    );
    expect(good).toEqual({ ok: true, output: '<img src="data:image/png;base64,AAA">' });
  });

  it("reports a missing row column as slot.column instead of rendering it blank", () => {
    const r = renderTemplate(tpl, {
      route: "x",
      date: "y",
      flights: [{ airline: "IndiGo" }],
      notes: "z",
    });
    expect(r).toEqual({ ok: false, missing: ["flights.fare"] });
  });

  it("escapes single quotes for pdf templates", () => {
    const r = renderTemplate(tpl, {
      route: "x",
      date: "y",
      flights: [{ airline: "O'Hare", fare: "1" }],
      notes: "it's fine",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toContain("O&#39;Hare");
      expect(r.output).toContain("it&#39;s fine");
    }
  });
});

describe("validateBrand", () => {
  it("rejects a logoDataUrl over the 512 KB image cap", () => {
    const big = `data:image/png;base64,${"A".repeat(700_001)}`;
    const r = validateBrand({ name: "Amigos", logoDataUrl: big, updatedAt: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("logoDataUrl is too large (max 512 KB image)");
  });

  it("accepts a logoDataUrl within the cap", () => {
    const ok = `data:image/png;base64,${"A".repeat(1000)}`;
    const r = validateBrand({ name: "Amigos", logoDataUrl: ok, updatedAt: 1 });
    expect(r.ok).toBe(true);
  });
});

describe("validateTemplate slot/rows kind and column checks", () => {
  it("rejects a rows-kind slot referenced with {{slot:name}}", () => {
    const r = validateTemplate({
      ...tpl,
      html: tpl.html.replace(
        "{{#rows:flights}}<tr><td>{{col:airline}}</td><td>{{col:fare}}</td></tr>{{/rows:flights}}",
        "{{slot:flights}}",
      ),
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors).toContain(
        'slot "flights" is a rows slot: use {{#rows:flights}}…{{/rows:flights}}',
      );
  });

  it("rejects a text/prose slot wrapped in {{#rows:name}}", () => {
    const r = validateTemplate({
      ...tpl,
      html: tpl.html.replace("{{slot:route}}", "{{#rows:route}}{{/rows:route}}"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('slot "route" is not a rows slot: use {{slot:route}}');
  });

  it("rejects a {{col:x}} placeholder outside any rows block", () => {
    const r = validateTemplate({ ...tpl, html: tpl.html + "{{col:extra}}" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("{{col:extra}} is only valid inside a rows block");
  });

  it("rejects a {{col:x}} inside a rows block that is not a declared column", () => {
    const r = validateTemplate({
      ...tpl,
      html: tpl.html.replace("{{col:airline}}", "{{col:carrier}}"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain('rows slot "flights" has no column "carrier"');
  });
});
