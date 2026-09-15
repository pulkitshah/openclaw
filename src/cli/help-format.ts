// Small help-text formatter shared by command registrations.
import { theme } from "../../packages/terminal-core/src/theme.js";
import { applyCliDisplayName } from "./command-format.js";

/** Command plus short description tuple used in help epilogues. */
type HelpExample = readonly [command: string, description: string];

function formatHelpExample(command: string, description: string): string {
  return `  ${theme.command(command)}\n    ${theme.muted(description)}`;
}

function formatHelpExampleLine(command: string, description: string): string {
  if (!description) {
    return `  ${theme.command(command)}`;
  }
  return `  ${theme.command(command)} ${theme.muted(`# ${description}`)}`;
}

/**
 * Render help examples in stacked or inline comment style.
 *
 * Every example is a command a reader is meant to run, so the binary token goes
 * through the shared display-name owner here rather than at each of the ~20 call
 * sites: an example literal is indistinguishable from a spawned or compared
 * command line, so only the renderer knows it is display text.
 */
export function formatHelpExamples(examples: ReadonlyArray<HelpExample>, inline = false): string {
  const formatter = inline ? formatHelpExampleLine : formatHelpExample;
  return examples
    .map(([command, description]) => formatter(applyCliDisplayName(command), description))
    .join("\n");
}
