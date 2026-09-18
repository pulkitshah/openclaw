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
//  - Only meaningful where this process controls the spawned command's environment AND the
//    spawned command's filesystem, since PATH resolution needs a real file at the resolved
//    directory, not just the right string in PATH. That holds for the gateway host and for the
//    Docker/Podman sandbox backends (`docker-backend.ts` bind-mounts this stub directory into the
//    container at the identical host-absolute path used in PATH, at container-creation time --
//    see `resolveSandboxConfigForAgent`'s `denySelfCli` field and `ensureSandboxContainerLifecycle`
//    in `docker.ts`). It does NOT hold for the remote-shell/SSH sandbox backend
//    (`remote-shell-backend.ts`): that backend's PATH env-building runs through the same code path
//    as every other host, so the directory string still gets prepended into PATH, but the
//    directory itself is a local, host-side path that cannot be made to exist on a genuinely
//    separate remote filesystem by this process -- shipping stub files to an arbitrary remote host
//    on every exec call is out of proportion for this layer, so that backend's self-CLI defense
//    remains the static check alone (the same tier as the node host, below). The node host
//    dispatches to a genuinely remote device via `system.run`; this process never controls that
//    device's PATH (and, separately, `tools.exec.pathPrepend` is already documented as ignored for
//    host=node for the same reason), so the node host's self-CLI defense remains the static check
//    alone — which is already unconditional there, independent of this module.
//  - A command that explicitly reassigns `PATH` before invoking the bare name (`env PATH=/usr/bin
//    vasudev ...`, or a script doing `export PATH=...` then calling `vasudev`) can still reach the
//    real binary if the reassigned PATH omits this shadow directory and still contains the real bin
//    directory. This requires deliberately naming a PATH value, a materially higher bar than the
//    zero-PATH-knowledge bypasses this layer closes, and is an accepted residual gap (see docs).
//  - Absolute-path invocation of the real binary bypasses PATH lookup entirely, but that case was
//    already covered by the static check's `resolvedPath`/`resolvedRealPath` identity matching on
//    the outer/direct segment; this module only targets the bare-name-via-indirection gap the static
//    check cannot structurally see.
import { constants as fsConstants } from "node:fs";
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
 * True when `dir` still looks like an intact shadow stub directory: the directory itself exists,
 * and every self-CLI bin name has both its POSIX stub (present and owner-executable) and its
 * Windows `.cmd` counterpart (present). This is a cheap existence/permission check, not a content
 * diff -- a stub whose *bytes* were altered but which is still present and executable is left
 * alone (mirrors the long-standing "reuses the cached directory... without re-preparing" contract
 * for in-place mutation); only actual deletion/removal triggers a repair.
 */
async function selfCliDenyStubDirIsIntact(dir: string): Promise<boolean> {
  try {
    const dirStat = await fs.stat(dir);
    if (!dirStat.isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }
  for (const name of SELF_CLI_BIN_NAMES) {
    try {
      await fs.access(path.join(dir, name), fsConstants.X_OK);
      await fs.access(path.join(dir, `${name}.cmd`), fsConstants.F_OK);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Idempotently prepares the PATH-shadow stub directory and returns its path. Safe to call
 * concurrently (and repeatedly) from multiple exec calls on the same desk: the first caller
 * creates the (static, never-changing) stub files once; concurrent and later callers await or
 * reuse the same result. Content is written atomically, so even a cross-process race writing the
 * same bytes to the same path is harmless.
 *
 * Callers must call this on every exec invocation that needs the shadow directory (not just once
 * per tool/session) -- see `bash-tools.exec-run.ts`. `$OPENCLAW_STATE_DIR` (where this directory
 * lives) is an ordinary, visible env var inside every exec'd command, including ones NOT flagged
 * `denySelfCli`, so an unrelated already-permitted command can delete this directory mid-session.
 * A permanently-trusted in-memory cache of "the directory exists" would let a later
 * `denySelfCli:true` call silently lose its PATH-shadow coverage after that deletion (round 5
 * finding). To close that: every call -- including one that would otherwise hit the cached-`dir`
 * fast path -- re-verifies the directory and its stub files still exist via
 * `selfCliDenyStubDirIsIntact` (a handful of cheap `fs.stat`/`fs.access` calls, not a rewrite) and
 * transparently repairs (recreates) anything missing before returning.
 *
 * Residual gap (accepted, not "no chances" against a perfect adversarial race -- see
 * `docs/tools/exec-approvals.md`): this check runs at preparation time, immediately before the
 * directory path is used to build the spawned command's PATH. A concurrent command that deletes
 * the directory in the narrow window between this check and the actual spawn could still slip
 * through for that one in-flight call. This is a TOCTOU window, not the structural, permanent gap
 * the reviewer's repro (delete, then a *separate, later* call) demonstrated; closing it fully
 * would need re-verifying immediately before every spawn rather than at preparation time, which is
 * disproportionate here since the practical mitigation (near-certain repair before each call)
 * already defeats the sequential repro this finding is about.
 */
export async function prepareSelfCliDenyPathShadow(
  options: { stateDir?: string } = {},
): Promise<string> {
  if (shadowState.dir) {
    if (await selfCliDenyStubDirIsIntact(shadowState.dir)) {
      return shadowState.dir;
    }
    // Tampered with (deleted, or a file/dir removed) since it was last verified: drop the stale
    // cache entirely -- including the resolved `preparing` promise, which would otherwise still
    // satisfy the `!shadowState.preparing` guard below and hand back the same stale directory
    // without ever rewriting anything -- and fall through to repair it like a fresh preparation.
    shadowState.dir = undefined;
    shadowState.preparing = undefined;
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
