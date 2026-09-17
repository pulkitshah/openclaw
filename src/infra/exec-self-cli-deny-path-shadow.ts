// Second, environment-level layer for `tools.exec.denySelfCli` (see `exec-self-cli-deny.ts` for
// the primary, static segment-analysis layer this supplements, and the rationale for denying the
// whole binary rather than individual subcommands).
//
// Motivation (Team v2 plan, Task 5, "structural pivot" fix round): the static check recognizes a
// self-CLI invocation by inspecting resolved command *segments*, recursing into a bounded set of
// known shell-wrapper forms (`bash -lc "..."`, `sh -c "..."`, nested dispatch wrappers). An
// adversarial re-review found that ANY other subprocess-spawning indirection tool — `pnpm exec`,
// `find -exec`, `xargs`, a scripting language's `subprocess`-by-name call, `ssh host cmd`, `docker
// run ... cmd`, a `make` recipe, etc. — can carry a bare `vasudev`/`openclaw` invocation buried
// inside it that the static analysis never inspects, because recognizing every such tool's syntax
// is an open-ended enumeration problem, not something a finite unwrap list can ever finish closing.
//
// Structural fix: rather than trying to parse and recognize every possible indirection tool BEFORE
// execution, make the real `vasudev`/`openclaw` binaries unresolvable by bare name within the
// spawned command's own environment. This module prepares a small "shadow" bin directory containing
// executable stub files literally named `vasudev`/`openclaw` (and `.cmd` counterparts for Windows)
// that immediately deny and exit non-zero. When `tools.exec.denySelfCli` is active, the caller
// prepends this directory ahead of every other PATH entry for the spawned command's environment.
// Standard PATH-lookup semantics (`execvp`-style resolution, which every POSIX shell, `pnpm`,
// `find -exec`, `xargs`, and virtually every language runtime's subprocess-by-name call ultimately
// use) mean ANY bare-name invocation of `vasudev`/`openclaw` anywhere in the entire process tree
// spawned from this call resolves to the stub first — a property of the inherited environment, not
// something each individual wrapper tool has to specially support. This closes the whole open-ended
// class of "unrecognized indirection tool" bypasses at once, including ones not yet discovered.
//
// Scope and residual gaps (do not overclaim "no chances" — see `exec-self-cli-deny.ts` and
// `docs/tools/exec-approvals.md` for the full, honest limitations list):
//  - This is a defense-in-depth ADDITION alongside the existing static check, not a replacement:
//    the static check still runs first and denies plenty of cases (including direct/absolute-path
//    invocation) before a process is ever spawned.
//  - Only meaningful where this process controls the spawned command's environment directly: the
//    gateway host (and, incidentally, the sandbox host's env-building, though sandbox has its own
//    separate deny posture and isn't part of `denySelfCli`'s current scope). The node host dispatches
//    to a genuinely remote device via `system.run`; this process never controls that device's PATH
//    (and, separately, `tools.exec.pathPrepend` is already documented as ignored for host=node for
//    the same reason), so the node host's self-CLI defense remains the static check alone — which is
//    already unconditional there, independent of this module.
//  - A command that explicitly reassigns `PATH` before invoking the bare name (`env PATH=/usr/bin
//    vasudev ...`, or a script doing `export PATH=...` then calling `vasudev`) can still reach the
//    real binary if the reassigned PATH omits this shadow directory and still contains the real bin
//    directory. This requires deliberately naming a PATH value, a materially higher bar than the
//    zero-PATH-knowledge bypasses this layer closes, and is an accepted residual gap (see docs).
//  - Absolute-path invocation of the real binary bypasses PATH lookup entirely, but that case was
//    already covered by the static check's `resolvedPath`/`resolvedRealPath` identity matching on
//    the outer/direct segment; this module only targets the bare-name-via-indirection gap the static
//    check cannot structurally see.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { SELF_CLI_BIN_NAMES } from "./exec-self-cli-deny.js";
import { writeTextAtomic } from "./json-files.js";

const SELF_CLI_DENY_STUB_DIR = path.join("tmp", "exec-self-cli-deny-stub");
const SELF_CLI_DENY_STATE_KEY = Symbol.for("openclaw.execSelfCliDenyPathShadow");

export const SELF_CLI_DENY_STUB_MESSAGE =
  "SYSTEM_RUN_DENIED: self-CLI invocation blocked (tools.exec.denySelfCli) -- use the agent's team_* tools instead of shelling out to vasudev/openclaw.";

type SelfCliDenyPathShadowState = {
  dir: string | undefined;
  preparing: Promise<string> | undefined;
};

const shadowState = resolveGlobalSingleton<SelfCliDenyPathShadowState>(
  SELF_CLI_DENY_STATE_KEY,
  () => ({ dir: undefined, preparing: undefined }),
  (state) => {
    state.dir = undefined;
    state.preparing = undefined;
  },
);

function renderPosixDenyStub(): string {
  // Best-effort attempt logging: appended to a file next to the stub, never allowed to affect the
  // stub's own exit status. A denial is a hard OS-level dead end -- it does not need to route
  // through the full approval/audit machinery to be effective.
  return `#!/bin/sh
printf '%s\\n' "${SELF_CLI_DENY_STUB_MESSAGE}" >&2
stub_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P)
if [ -n "$stub_dir" ]; then
  printf '%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$0" "$*" >> "$stub_dir/attempts.log" 2>/dev/null || true
fi
exit 1
`;
}

function renderWindowsDenyStub(): string {
  // Keep this minimal and syntactically simple. Best-effort attempt logging is POSIX-only (see
  // `renderPosixDenyStub`); it is not essential to the deny and not worth the batch-quoting risk.
  return ["@echo off", `echo ${SELF_CLI_DENY_STUB_MESSAGE} 1>&2`, "exit /b 1", ""].join("\r\n");
}

async function writeSelfCliDenyStubFiles(binDir: string): Promise<void> {
  await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
  await fs.chmod(binDir, 0o700).catch(() => undefined);
  const posixContent = renderPosixDenyStub();
  const windowsContent = renderWindowsDenyStub();
  for (const name of SELF_CLI_BIN_NAMES) {
    await writeTextAtomic(path.join(binDir, name), posixContent, {
      mode: 0o700,
      dirMode: 0o700,
      durable: false,
      tempPrefix: "exec-self-cli-deny-stub",
    });
    await writeTextAtomic(path.join(binDir, `${name}.cmd`), windowsContent, {
      mode: 0o700,
      dirMode: 0o700,
      durable: false,
      tempPrefix: "exec-self-cli-deny-stub",
    });
  }
}

/**
 * Idempotently prepares the PATH-shadow stub directory and returns its path. Safe to call
 * concurrently (and repeatedly) from multiple exec calls on the same desk: the first caller
 * creates the (static, never-changing) stub files once; concurrent and later callers await or
 * reuse the same result. Content is written atomically, so even a cross-process race writing the
 * same bytes to the same path is harmless.
 */
export async function prepareSelfCliDenyPathShadow(
  options: { stateDir?: string } = {},
): Promise<string> {
  if (shadowState.dir) {
    return shadowState.dir;
  }
  if (!shadowState.preparing) {
    const binDir = path.join(options.stateDir ?? resolveStateDir(), SELF_CLI_DENY_STUB_DIR);
    shadowState.preparing = writeSelfCliDenyStubFiles(binDir)
      .then(() => {
        shadowState.dir = binDir;
        return binDir;
      })
      .catch((error: unknown) => {
        // Let the next call retry preparation instead of caching a permanent failure.
        shadowState.preparing = undefined;
        throw error;
      });
  }
  return shadowState.preparing;
}

/** Test-only reset so fixtures don't leak a prepared directory across test files. */
export function clearSelfCliDenyPathShadowForTest(): void {
  shadowState.dir = undefined;
  shadowState.preparing = undefined;
}
