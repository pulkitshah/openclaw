import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const helper = "scripts/e2e/lib/onboard/owner-name-flow.sh";

describe.skipIf(process.platform === "win32")("guided owner-name prompt handshake", () => {
  it.each([
    ["plain", 5],
    ["fragmented", 5],
  ] as const)("drives the real guided sender through %s prompts", (rendering, count) => {
    const root = dirs.make("onboard-owner-name-flow-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR="$CASE_ROOT"
source scripts/e2e/lib/onboard/scenario.sh
trap 'rm -rf "$ONBOARD_TMP_DIR"' EXIT
WIZARD_LOG_PATH="$CASE_ROOT/prompts.log"
export WIZARD_LOG_PATH
prompts=("Help make OpenClaw better?" "What's your name?" "How should I set things up?" "Model/auth provider" "Use which detected AI?")
index=0
render() {
  "$NODE_BIN" -e 'const fs=require("node:fs"); const text=process.argv[2]; fs.writeFileSync(process.argv[1], process.env.RENDERING === "fragmented" ? text.split("").join("\\n") : text);' "$WIZARD_LOG_PATH" "$1"
}
# The terminal is the boundary double. Prompt recognition and the production
# sender are real; unexpected keystrokes or out-of-order waits fail immediately.
wait_for_log() {
  if ! log_contains "$1"; then
    printf 'unexpected wait: %s\\n' "$1" >&2
    return 21
  fi
}
send() {
  [[ "$1" == $'\\r' || "$1" == $'Owner\\r' ]] || { echo 'unexpected keystroke' >&2; return 22; }
  index=$((index + 1))
  render "\${prompts[$index]:-DONE}"
}
render "\${prompts[0]}"
send_guided_skip_ui_flow
[[ "$index" == "\${#prompts[@]}" ]]
printf 'responses=%s\\n' "$index"
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CASE_ROOT: root,
          RENDERING: rendering,
          NODE_BIN: process.execPath,
        },
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`responses=${count}`);
  });

  it("fails instead of sending blindly when the prompt never renders", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
source ${helper}
count=0
contains() { return 1; }
send() { count=$((count + 1)); }
wait_for_owner_name_prompt contains 1
status=$?
printf 'inputs=%s\\n' "$count"
exit "$status"
`,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toBe("inputs=0");
    expect(result.stderr).toContain("Timeout waiting for owner-name prompt");
  });
});
