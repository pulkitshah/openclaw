import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Vasudev orb is the only mark. This guard covers the brand artwork: image
// files whose name still says lobster/crab/mascot, the references that point at
// them from the Control UI and CLI sources, the docs manifest's logo/favicon,
// and the crustacean glyph the CLI banner used to print. The opt-in LobsterDex
// pet is a separate, named product feature drawn in code, not brand artwork, so
// its module names are deliberately out of scope here.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const MARK_NAME = /lobster|crab|mascot/iu;
const ASSET_EXTENSIONS = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
  ".avif",
]);
/** Any asset path or filename in source that still names the retired mark. */
const ASSET_REFERENCE =
  /[\w@/.-]*(?:lobster|crab|mascot)[\w.-]*\.(?:svg|png|jpe?g|webp|gif|ico|avif)/giu;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".vite", ".git"]);

function walkFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry)) {
      continue;
    }
    const absolute = path.join(root, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...walkFiles(absolute));
      continue;
    }
    files.push(absolute);
  }
  return files;
}

function repoRelative(absolute: string): string {
  return path.relative(repoRoot, absolute).replaceAll("\\", "/");
}

function assetFilesNamingTheRetiredMark(...roots: string[]): string[] {
  return roots
    .flatMap((root) => walkFiles(path.join(repoRoot, root)))
    .filter(
      (file) =>
        ASSET_EXTENSIONS.has(path.extname(file).toLowerCase()) &&
        MARK_NAME.test(path.basename(file)),
    )
    .map(repoRelative)
    .sort();
}

function assetReferencesNamingTheRetiredMark(...roots: string[]): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, root);
    const files = statSync(absoluteRoot).isDirectory() ? walkFiles(absoluteRoot) : [absoluteRoot];
    for (const file of files) {
      if (ASSET_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        continue;
      }
      const matches = readFileSync(file, "utf8").match(ASSET_REFERENCE);
      for (const match of matches ?? []) {
        hits.push(`${repoRelative(file)}: ${match}`);
      }
    }
  }
  return hits.sort();
}

/** Element names are discussed in prose too; only real markup is a call site. */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/^\s*\/\/.*$/gmu, "");
}

describe("brand marks", () => {
  it("ships no lobster, crab or mascot artwork in the Control UI or docs assets", () => {
    expect(assetFilesNamingTheRetiredMark("ui", "docs/assets")).toEqual([]);
  });

  it("references no lobster, crab or mascot artwork from the Control UI, CLI or docs manifest", () => {
    expect(assetReferencesNamingTheRetiredMark("ui/src", "src/cli", "docs/docs.json")).toEqual([]);
  });

  it("spends the signature gradient once per screen at every wordmark call site", () => {
    // The orb and the wordmark's "dev" both paint the gradient, so a lockup
    // that shows them together must ask the wordmark for ink. Every placement
    // in the product sits beside the orb; an orb-less one would be the screen's
    // only mark and belongs in this list with its own reason.
    const callSites = walkFiles(path.join(repoRoot, "ui/src"))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .flatMap((file) =>
        (withoutComments(readFileSync(file, "utf8")).match(/<vasu-wordmark[^>]*>/gu) ?? []).map(
          (tag) => `${repoRelative(file)}: ${tag.replace(/\s+/gu, " ")}`,
        ),
      );

    expect(callSites.length).toBeGreaterThan(0);
    expect(callSites.filter((site) => !site.includes("beside-orb"))).toEqual([]);
  });

  // Both banner sources: banner.ts owns the one-line mark, claw-banner.ts draws
  // the animated wordmark frame. Either one can reintroduce the retired mark on
  // its own, so both carry the orb glyph and neither may carry crustacean art.
  it.each(["src/cli/banner.ts", "src/cli/claw-banner.ts"])(
    "prints no crustacean glyph in %s",
    (source) => {
      const banner = readFileSync(path.join(repoRoot, source), "utf8");

      expect(banner).not.toMatch(/[🦞🦀]/u);
      expect(banner).not.toMatch(/lobster/iu);
      expect(banner).toContain("◉");
    },
  );
});
