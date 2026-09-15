// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Vasudev's voice (see the `vasudev-brand` guide): plain verbs, sentence case, no exclamation
 * marks, no emoji in product copy, and never the stock SaaS phrasing the guide's "We Never Say"
 * column rules out. This test reads `en.ts` as source text (matching `brand.test.ts`'s approach)
 * rather than importing the module, so it catches violations without needing the Control UI's
 * browser-only runtime.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const EN_PATH = path.join(here, "en.ts");

const FORBIDDEN_PHRASES = [
  "AI-powered",
  "seamless",
  "autonomous agentic",
  "An error occurred",
  "Pending user input required",
];

/**
 * Extended_Pictographic covers the emoji Unicode uses for pictographs (faces, objects, symbols
 * chosen for emoji presentation) without flagging plain punctuation that happens to share a
 * block, e.g. U+2726 BLACK FOUR POINTED STAR or the U+2192 arrows this catalog uses as link
 * affordances ("Read the docs →") — neither is Extended_Pictographic, so neither trips this test.
 */
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

/**
 * No current `en.ts` value needs this allowlist — there is no literal emoji glyph in the catalog
 * today. It exists so a future identity/avatar emoji picker (real emoji characters offered as
 * options, not just copy describing "Emoji") can list its glyphs here instead of the test
 * blocking that feature; add exact string values, not keys, so the exemption is easy to audit.
 */
const EMOJI_ALLOWLIST = new Set<string>([]);

/**
 * Pulls every quoted string that appears in *value* position out of `en.ts`'s source text: a
 * string immediately followed (after whitespace) by `:` is an object key (e.g. `"session-list":
 * "Session list"` or a multi-line `longKey:\n  "value",`) and is skipped, everything else is
 * product copy. This avoids needing a full TS parser for a flat translation-map literal.
 */
function extractValueStrings(source: string): string[] {
  const stringPattern = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = stringPattern.exec(source)) !== null) {
    const raw = match[0];
    const afterEnd = source.slice(match.index + raw.length);
    const isKey = /^\s*:/.test(afterEnd);
    if (isKey) {
      continue;
    }
    const quote = raw[0];
    const inner = raw.slice(1, -1);
    values.push(quote === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/\\'/g, "'"));
  }
  return values;
}

describe("en.ts product copy follows the Vasudev voice", () => {
  const source = readFileSync(EN_PATH, "utf8");
  const values = extractValueStrings(source);

  it("extracts a plausible number of catalog strings", () => {
    // Sanity check on the extractor itself: en.ts is thousands of lines of translation entries.
    expect(values.length).toBeGreaterThan(500);
  });

  it.each(FORBIDDEN_PHRASES)("never uses the stock phrase %j", (phrase) => {
    const hit = values.find((value) => value.toLowerCase().includes(phrase.toLowerCase()));
    expect(hit).toBeUndefined();
  });

  it("never ends a UI string with an exclamation mark", () => {
    const offenders = values.filter((value) => value.trimEnd().endsWith("!"));
    expect(offenders).toEqual([]);
  });

  it("never carries emoji outside the identity emoji picker allowlist", () => {
    const offenders = values.filter(
      (value) => EMOJI_PATTERN.test(value) && !EMOJI_ALLOWLIST.has(value),
    );
    expect(offenders).toEqual([]);
  });
});
