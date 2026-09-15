import { describe, expect, it } from "vitest";
import {
  createDocumentedCompletionProgram,
  runGeneratedBashCompletion,
} from "./completion-cli.test-support.js";

describe("completion-cli native Bash words", () => {
  it.skipIf(process.platform !== "darwin")("uses macOS Bash byte offsets in a UTF-8 locale", () => {
    const prefix = "vasudev gateway --token=é status --j";

    expect(
      runGeneratedBashCompletion(
        createDocumentedCompletionProgram(),
        ["openclaw", "gateway", "--token=é", "status", "--json"],
        {
          line: `${prefix}son`,
          word: "--j",
          point: Buffer.byteLength(prefix),
          bashPath: "/bin/bash",
          env: { ...process.env, LC_ALL: "en_US.UTF-8" },
        },
      ),
    ).toEqual(["--json"]);
  });

  it.skipIf(process.platform === "win32").each([
    {
      line: "vasudev completion --shell=",
      words: ["openclaw", "completion", "--shell", "="],
      word: "",
      expected: ["zsh", "bash", "powershell", "fish"],
    },
    {
      line: "vasudev --profile=gateway completion --shell f",
      words: ["openclaw", "--profile", "=", "gateway", "completion", "--shell", "f"],
      word: "f",
      expected: ["fish"],
    },
    {
      line: "vasudev completion --shell=f",
      words: ["openclaw", "completion", "--shell=f"],
      word: "f",
      expected: ["fish"],
    },
    {
      line: "vasudev completion --shell=fish",
      words: ["openclaw", "completion", "--shell", "=", "fish"],
      word: "f",
      point: 29,
      expected: ["fish"],
    },
    {
      line: "vasudev completion --shell=fish",
      words: ["openclaw", "completion", "--shell=fish"],
      word: "f",
      point: 29,
      expected: ["fish"],
    },
    {
      line: "vasudev completion --shell=fish",
      words: ["openclaw", "completion", "--shell", "=", "fish"],
      word: "",
      point: 28,
      expected: ["zsh", "bash", "powershell", "fish"],
    },
    {
      line: "vasudev completion --shell=bogus",
      words: ["openclaw", "completion", "--shell", "=", "bogus"],
      word: "b",
      point: 29,
      expected: ["bash"],
    },
    {
      line: "vasudev completion --sh=fish",
      words: ["openclaw", "completion", "--sh=fish"],
      word: "--sh",
      point: 24,
      expected: ["--shell"],
    },
    {
      line: "vasudev completion -ysfish",
      words: ["openclaw", "completion", "-ysfish"],
      word: "-ysf",
      point: 24,
      expected: ["-ysfish"],
    },
    {
      line: "vasudev --profile=gateway completion --shell=fish --yes",
      words: [
        "openclaw",
        "--profile",
        "=",
        "gateway",
        "completion",
        "--shell",
        "=",
        "fish",
        "--yes",
      ],
      word: "f",
      point: 47,
      cword: 7,
      expected: ["fish"],
    },
    {
      line: "vasudev completion --shell=fish",
      words: ["openclaw", "completion", "--shell=fish"],
      word: "comple",
      point: 15,
      cword: 1,
      expected: ["completion"],
    },
    {
      line: "vasudev gateway --token = status --j",
      words: ["openclaw", "gateway", "--token", "=", "status", "--j"],
      word: "--j",
      expected: ["--json"],
    },
    {
      line: "vasudev completion>/dev/null --shell f",
      words: ["openclaw", "completion", ">", "/dev/null", "--shell", "f"],
      word: "f",
      expected: ["fish"],
    },
    {
      line: "vasudev gateway --token=prefix:status --f",
      words: ["openclaw", "gateway", "--token", "=", "prefix", ":", "status", "--f"],
      word: "--f",
      expected: ["--force"],
    },
    {
      line: "vasudev gateway --token=foo==status --f",
      words: ["openclaw", "gateway", "--token", "=", "foo", "==", "status", "--f"],
      word: "--f",
      expected: ["--force"],
    },
    ...['"f', "'f", '"f"', "\\f", 'f"i'].map((value) => ({
      line: `vasudev completion --shell ${value}`,
      words: ["openclaw", "completion", "--shell", value],
      word: value === 'f"i' ? "i" : value === '"f' || value === "'f" ? "f" : value,
      expected: [value === 'f"i' ? "ish" : "fish"],
    })),
    ...['"', "'"].flatMap((quote) => [
      {
        line: `vasudev completion --shell=${quote}f`,
        words: ["openclaw", "completion", `--shell=${quote}f`],
        word: "f",
        expected: ["fish"],
      },
      {
        line: `vasudev completion --shell=${quote}f`,
        words: ["openclaw", "completion", "--shell", "=", `${quote}f`],
        word: "f",
        expected: ["fish"],
      },
      {
        line: `vasudev completion -s ${quote}f`,
        words: ["openclaw", "completion", "-s", `${quote}f`],
        word: "f",
        expected: ["fish"],
      },
    ]),
  ])("respects native Bash word boundaries in $line at $point", ({ words, expected, ...input }) => {
    const program = createDocumentedCompletionProgram().option("--profile <name>", "Profile");

    expect(runGeneratedBashCompletion(program, words, input)).toEqual(expected);
  });
});
