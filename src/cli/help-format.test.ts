// Help examples are display text: the renderer owns the displayed binary name.
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { CLI_NAME } from "./cli-name.js";
import { formatHelpExamples } from "./help-format.js";

describe("formatHelpExamples", () => {
  it("shows the product alias for the binary token in both styles", () => {
    // Inputs are authored the way every example table is: naming the installed
    // binary, which is what the renderer has to translate.
    const stacked = stripAnsi(
      formatHelpExamples([[`${CLI_NAME} update --json`, "Output result as JSON"]]),
    );
    const inline = stripAnsi(
      formatHelpExamples([[`pnpm ${CLI_NAME} doctor`, "Repair common problems"]], true),
    );

    expect(stacked).toContain("vasudev update --json");
    expect(stacked).not.toContain("openclaw");
    expect(inline).toContain("pnpm vasudev doctor");
  });

  it("leaves a non-binary leading token alone", () => {
    const rendered = stripAnsi(
      formatHelpExamples([[`npx ${CLI_NAME}-doctor`, "Third-party tool"]]),
    );

    expect(rendered).toContain(`npx ${CLI_NAME}-doctor`);
  });
});
