// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CLI_DISPLAY_NAME } from "../../../../src/brand.js";
import { INTERNAL_TERMINAL_PATH_PARAM } from "../../app-route-paths.ts";
import {
  isTerminalFirstRunLocation,
  TERMINAL_FIRST_RUN_COMMAND,
  TERMINAL_FIRST_RUN_SEARCH,
} from "./first-run-command.ts";

describe("terminal first-run command", () => {
  it("runs the guided CLI setup under the displayed product binary", () => {
    expect(TERMINAL_FIRST_RUN_COMMAND).toBe(
      `${CLI_DISPLAY_NAME} onboard --skip-daemon --no-install-daemon --skip-ui --skip-health`,
    );
  });

  it.each([
    { name: "the redirect search", search: TERMINAL_FIRST_RUN_SEARCH, expected: true },
    { name: "a marker beside other queries", search: "?firstRun=1&other=x", expected: true },
    { name: "no query at all", search: "", expected: false },
    { name: "a cleared marker", search: "?other=x", expected: false },
    { name: "a marker the route did not write", search: "?firstRun=yes", expected: false },
  ])("reads $name", ({ search, expected }) => {
    expect(isTerminalFirstRunLocation({ pathname: "/terminal", search, hash: "" })).toBe(expected);
  });

  it("reads the marker through the router path bridge", () => {
    expect(
      isTerminalFirstRunLocation({
        pathname: "/openclaw/terminal",
        search: `?${new URLSearchParams({
          [INTERNAL_TERMINAL_PATH_PARAM]: "/openclaw/terminal",
          firstRun: "1",
        })}`,
        hash: "",
      }),
    ).toBe(true);
  });
});
