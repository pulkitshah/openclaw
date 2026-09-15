// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../app/brand.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The upstream project's name no longer belongs in any catalog: the About page
 * shows only "Vasudev · by TripIn Studio", and upstream's MIT notice moved to the
 * Licences disclosure, whose text lives in `ui/src/pages/about/upstream-licence.ts`
 * (the one reviewed exemption — spec section 2b). The notice file is asserted
 * below so the exemption cannot go dead. */
const UPSTREAM_LICENCE_MODULE = "../../pages/about/upstream-licence.ts";

/** Only the English catalogs are source-owned copy. The other locales are
 * generated from translation memory and are refreshed by the locale workflow,
 * so a stale product name there is a generation lag, not a source defect. */
function englishCatalogFiles(): string[] {
  return readdirSync(here)
    .filter((name) => (name === "en.ts" || name.startsWith("en-")) && name.endsWith(".ts"))
    .toSorted();
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
    expect(source).not.toMatch(/\bClawd\b/u);
  });

  it("keeps the upstream MIT notice in the Licences module the catalogs no longer carry", () => {
    const notice = readFileSync(path.join(here, UPSTREAM_LICENCE_MODULE), "utf8");
    expect(notice).toContain("MIT License");
    expect(notice).toContain("OpenClaw Foundation");
  });

  it("names the product in the shared catalog", () => {
    const source = readFileSync(path.join(here, "en.ts"), "utf8");
    expect(source.includes(PRODUCT_NAME)).toBe(true);
  });
});
