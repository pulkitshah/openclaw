// Help examples are display text: the renderer owns the displayed binary name.
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { formatHelpExamples } from "./help-format.js";

describe("formatHelpExamples", () => {
  it("shows the product alias for the binary token in both styles", () => {
    const stacked = stripAnsi(
      formatHelpExamples([["openclaw update --json", "Output result as JSON"]]),
    );
    const inline = stripAnsi(
      formatHelpExamples([["pnpm openclaw doctor", "Repair common problems"]], true),
    );

    expect(stacked).toContain("vasudev update --json");
    expect(stacked).not.toContain("openclaw");
    expect(inline).toContain("pnpm vasudev doctor");
  });

  it("leaves a non-binary leading token alone", () => {
    const rendered = stripAnsi(formatHelpExamples([["npx openclaw-doctor", "Third-party tool"]]));

    expect(rendered).toContain("npx openclaw-doctor");
  });
});
