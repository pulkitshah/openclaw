import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../src/brand.ts";

// The two `--version` fast paths answer before anything else loads: the
// launcher (`openclaw.mjs`) runs as plain JavaScript with no TypeScript in the
// process, and `src/entry.version-fast-path.ts` deliberately prints before the
// CLI module graph is imported. Both therefore spell the product name as a
// literal instead of importing `src/brand.ts` — the one sanctioned duplicate of
// PRODUCT_NAME in the tree. This guard is what keeps the duplicate honest: if
// the brand module is renamed and these two literals are not, the test fails
// instead of `--version` quietly printing the old name.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

const LAUNCHER = "openclaw.mjs";
const ENTRY_FAST_PATH = "src/entry.version-fast-path.ts";

/** The product-name token every `<Name> <version>` line in `source` starts with. */
function versionLineProductNames(source: string): string[] {
  return [...source.matchAll(/`([A-Za-z][A-Za-z0-9]*) \$\{(?:VERSION|version)\}/gu)].map(
    (match) => match[1] as string,
  );
}

describe("--version fast paths", () => {
  it.each([LAUNCHER, ENTRY_FAST_PATH])("%s prints PRODUCT_NAME", (relativePath) => {
    const names = versionLineProductNames(read(relativePath));
    // Both the plain and the with-commit form.
    expect(names.length).toBe(2);
    for (const name of names) {
      expect(name).toBe(PRODUCT_NAME);
    }
  });

  it.each([LAUNCHER, ENTRY_FAST_PATH])(
    "%s keeps the fast path free of brand imports",
    (relativePath) => {
      // Importing the brand module here would defeat the fast path; the test
      // above is the substitute for that import, so it must stay the only link.
      expect(read(relativePath)).not.toMatch(/from "[^"]*brand(?:\.[tj]s)?"/u);
    },
  );
});
