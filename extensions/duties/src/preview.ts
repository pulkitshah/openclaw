import path from "node:path";
import type { RenderAdapter } from "./adapters/render.js";
import { safeFileName } from "./files.js";
import type { DutyStore } from "./store.js";
import { placeholderData, renderTemplate } from "./template.js";

/** One owner for "render this template to a throwaway PDF", shared by the `template_preview` tool
 *  and the `duties.template.preview` Gateway method so the two can never disagree about what the
 *  owner is looking at. Previews land in `previewDir()`, outside any run's directory, because they
 *  belong to no run and are not evidence.
 *
 *  `pdf` templates only: `renderTemplate` escapes by the template's own kind, so serving a message
 *  template's literal body to the browser would hand it unescaped markup — the same ruling the
 *  runner's `template` step already makes about a mismatched `format`. */
export async function renderTemplatePreview(params: {
  store: Pick<DutyStore, "getTemplate" | "getBrand">;
  render: RenderAdapter;
  previewDir: () => Promise<string>;
  id: string;
  data?: Record<string, unknown>;
}): Promise<{ path: string; bytes: number }> {
  const template = await params.store.getTemplate(params.id);
  if (!template) throw new Error(`no template "${params.id}"`);
  if (template.kind !== "pdf") {
    throw new Error(
      `template "${template.id}" is a ${template.kind} template; preview renders pdf templates only`,
    );
  }
  const rendered = renderTemplate(
    template,
    params.data ?? placeholderData(template),
    await params.store.getBrand(),
  );
  if (!rendered.ok) throw new Error(`slot "${rendered.missing[0]}" could not be filled`);
  // Named like anything else the owner is shown, and marked a preview so a file that reaches them
  // out of context cannot be mistaken for a document a run actually produced and sent.
  const name =
    safeFileName(`${template.name} preview ${Date.now()}`, ".pdf") ??
    `${template.id}-preview-${Date.now()}.pdf`;
  const dest = path.join(await params.previewDir(), name);
  const { bytes } = await params.render.toPdf(rendered.output, dest);
  return { path: dest, bytes };
}
