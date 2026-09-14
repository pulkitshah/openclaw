// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../app/brand.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Only the English catalogs are source-owned copy. The other locales are
 * generated from translation memory and are refreshed by the locale workflow,
 * so a stale product name there is a generation lag, not a source defect. */
function englishCatalogFiles(): string[] {
  return readdirSync(here)
    .filter((name) => (name === "en.ts" || name.startsWith("en-")) && name.endsWith(".ts"))
    .sort();
}

describe("English catalogs carry the product name", () => {
  it("covers every English catalog", () => {
    const files = englishCatalogFiles();
    expect(files).toContain("en.ts");
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(englishCatalogFiles())("%s never names the upstream product", (file) => {
    const source = readFileSync(path.join(here, file), "utf8");
    expect(source).not.toMatch(/\bOpenClaw\b/u);
  });

  it("names the product in the shared catalog", () => {
    const source = readFileSync(path.join(here, "en.ts"), "utf8");
    expect(source.includes(PRODUCT_NAME)).toBe(true);
  });
});
