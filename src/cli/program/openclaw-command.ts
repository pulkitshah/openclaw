// Commander subclass that preserves the exact failing command for parse-error guidance.
import { Command, CommanderError, type ErrorOptions, type Help } from "commander";
import { applyCliDisplayName } from "../command-format.js";
import { applyResolvedCommandOutputMode, isJsonOutputModeActive } from "../json-output-mode.js";
import {
  getCommanderErrorCommandNames,
  getCommanderErrorCommandPath,
  getCommanderSubcommandFact,
  hasCommanderOptionToken,
  setCommanderErrorCommand,
} from "./commander-parse-facts.js";
import { createCliParseError } from "./error-output.js";
import { isCommandJsonOutputMode } from "./json-mode.js";

// Commander 15 declares this help hook only in its runtime class, not its types.
// Declaring it here lets the subclass override and delegate through `super`
// instead of re-binding a captured prototype method.
declare module "commander" {
  interface Command {
    _outputHelpIfRequested(args: string[]): void;
  }
}

export class OpenClawCommand extends Command {
  override createCommand(name?: string): Command {
    return new OpenClawCommand(name);
  }

  // Commander builds the `Usage:` line from the root command's registered name,
  // which stays the real binary (`CLI_NAME`) because completion registration and
  // process titles key off it. Displayed help is a product surface, so the usage
  // line goes through the shared display-name owner instead.
  override createHelp(): Help {
    const help = super.createHelp();
    const renderCommandUsage = help.commandUsage.bind(help);
    help.commandUsage = (cmd) => applyCliDisplayName(renderCommandUsage(cmd));
    return help;
  }

  override error(message: string, errorOptions?: ErrorOptions): never {
    const restoreErrorCommand = setCommanderErrorCommand(this);
    try {
      return super.error(message, errorOptions);
    } catch (error) {
      if (
        error instanceof CommanderError &&
        error.exitCode !== 0 &&
        (isJsonOutputModeActive(process.argv) || isCommandJsonOutputMode(this, process.argv))
      ) {
        if (
          !isCommandJsonOutputMode(this, process.argv) &&
          !hasCommanderOptionToken(this, process.argv, new Set(["--json"]), "flag")
        ) {
          applyResolvedCommandOutputMode(false);
          throw error;
        }
        applyResolvedCommandOutputMode(true);
        throw createCliParseError(
          message,
          {
            argv: process.argv,
            commandPath: getCommanderErrorCommandPath(this),
            commandNames: getCommanderErrorCommandNames(this),
          },
          { humanOutputWritten: true },
        );
      }
      throw error;
    } finally {
      restoreErrorCommand();
    }
  }

  // Commander 15 checks this internal hook before dispatching actions.
  // Defer only marked lazy placeholders so their real command tree can decide.
  override _outputHelpIfRequested(args: string[]): void {
    const subcommandFact = getCommanderSubcommandFact(this, args);
    if (subcommandFact?.kind === "defer") {
      return;
    }
    if (subcommandFact?.kind === "unknown") {
      this.error(`error: unknown command '${subcommandFact.name}'`, {
        code: "commander.unknownCommand",
      });
    }
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Commander 15.0.0 owns this hook name; package.json pins that exact version.
    super._outputHelpIfRequested(args);
  }
}
