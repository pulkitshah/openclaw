// Denies the agent's own CLI binary as an exec target, independent of `tools.exec` mode.
//
// Rationale (Team v2 plan, "Exec restriction: deny agent self-CLI invocation"): once an agent has
// real, agent-callable tools for roster management (`team_add`/`team_remove`/`team_transfer_ownership`),
// there is no legitimate reason for that agent to shell out to its own CLI — every legitimate
// CLI-shaped action (pairing approval, config edits, etc.) has a proper tool-call path instead.
// Closing the whole binary is simpler and more complete than denying individual dangerous
// subcommands (`pairing approve`, `config set`, ...) one at a time.
//
// Mechanism: this reuses the same resolved command segments `tools.exec.strictInlineEval` already
// consults for its own mode-independent check (see `evaluateShellAllowlistWithAuthorization`) — no
// new segment/analysis machinery. Unlike `strictInlineEval`, a hit here is a hard, unconditional
// deny: no reviewer, no human approval, no `full`/`allowlist`/`ask`/`auto` mode escapes it.
//
// Scope: this is a narrow binary-identity check, not a substring match. It flags a command segment
// only when its resolved executable name is *exactly* one of this product's two CLI binary names
// (`vasudev`, `openclaw` — see package.json's `bin` field; both alias the same entry point), whether
// invoked bare (PATH lookup), via a relative/absolute path, or through a transparent dispatch/shell
// wrapper (`env`, `nice`, `pnpm exec`, etc.). A path like `/home/vasudev-user/script.sh` is
// unaffected: its basename is `script.sh`, not `vasudev`.
//
// Shell-wrapper recursion: a generic shell wrapper (`bash -lc "..."`, `sh -c "..."`, including a
// login-mode form and nested dispatch wrappers like `env bash -lc "..."`) is NOT unwrapped by
// `evaluateShellAllowlistWithAuthorization`'s own returned segments when the wrapper's startup mode
// makes it unsafe to *cache* the inline payload as a trusted, reusable command (see
// `extractBindableShellWrapperInlineCommand` / `canUseWrapperShellInvocation` in
// `exec-authorization-plan.ts`) — that caution is about the ALLOW path (don't auto-trust a payload
// whose surrounding login/profile startup could run something else first), and it does not apply to
// this DENY check: whatever text a shell wrapper's inline-command flag carries is executed verbatim
// regardless of what its startup files also do, so it is always safe (and necessary) to look inside
// it here. `detectSelfCliInvocation` therefore recurses into any shell-wrapper inline payload via
// `extractShellWrapperInlineCommand` (the unrestricted extractor, also used by the command explainer
// to build its own nested-command view) and re-resolves it through
// `evaluateShellAllowlistWithAuthorization` to find further segments, to a bounded depth
// (`MAX_DISPATCH_WRAPPER_DEPTH`, the same bound already used for dispatch-wrapper unwrapping) — this
// is the one shared recursion point both the gateway and node exec hosts call through, so there is
// no second, divergent unwrapper.
//
// Known limitation: invoking the underlying entry script directly through a generic interpreter
// (for example `node /path/to/openclaw.mjs ...`) is not detected here. Closing that would require
// binding argv-token realpaths against the entry script itself, which is the kind of general
// interpreter/loader coverage the exec-approvals engine already documents as best-effort elsewhere
// (see `resolveAllowAlwaysPatternEntries` / interpreter binding docs) — out of scope for this narrow
// identity check.

import path from "node:path";
import { MAX_DISPATCH_WRAPPER_DEPTH } from "./dispatch-wrapper-resolution.js";
import { evaluateShellAllowlistWithAuthorization } from "./exec-approvals-allowlist.js";
import type { ExecCommandSegment } from "./exec-command-analysis-types.js";
import {
  resolveExecutionTargetResolution,
  resolvePolicyTargetResolution,
  type ExecutableResolution,
} from "./exec-command-resolution.js";
import { extractShellWrapperInlineCommand } from "./shell-wrapper-resolution.js";

/** Bare command names that resolve to this product's own CLI entry point (package.json `bin`). */
export const SELF_CLI_BIN_NAMES: readonly string[] = Object.freeze(["vasudev", "openclaw"]);

const SELF_CLI_BIN_NAME_SET = new Set(SELF_CLI_BIN_NAMES);

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat", ".com"]);

function stripWindowsExecutableExtension(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return WINDOWS_EXECUTABLE_EXTENSIONS.has(ext) ? name.slice(0, name.length - ext.length) : name;
}

/** Normalizes a raw token or resolved path down to a comparable bare executable name. */
function normalizeExecutableIdentityName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const base = path.basename(trimmed);
  if (!base) {
    return undefined;
  }
  const normalized = stripWindowsExecutableExtension(base).toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function resolutionNamesSelfCli(resolution: ExecutableResolution | null): boolean {
  if (!resolution) {
    return false;
  }
  const candidates = [
    normalizeExecutableIdentityName(resolution.rawExecutable),
    normalizeExecutableIdentityName(resolution.resolvedPath),
    normalizeExecutableIdentityName(resolution.resolvedRealPath),
    normalizeExecutableIdentityName(resolution.executableName),
  ];
  return candidates.some((name) => name !== undefined && SELF_CLI_BIN_NAME_SET.has(name));
}

/** True when a resolved command segment's execution or policy target is this product's own CLI. */
export function isSelfCliCommandSegment(segment: ExecCommandSegment): boolean {
  const resolution = segment.resolution;
  if (!resolution) {
    return false;
  }
  return (
    resolutionNamesSelfCli(resolveExecutionTargetResolution(resolution)) ||
    resolutionNamesSelfCli(resolvePolicyTargetResolution(resolution))
  );
}

/**
 * Resolution context the self-CLI check needs to recurse into a shell-wrapper's inline payload
 * (`bash -lc "..."`, `sh -c "..."`, ...): the same `cwd`/`env`/`platform`/safe-bin inputs the
 * caller already passed to its own `evaluateShellAllowlistWithAuthorization` call for the outer
 * command. All fields are optional so existing non-recursing callers/tests are unaffected.
 */
export type SelfCliDetectionContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
  safeBins?: Set<string>;
  trustedSafeBinDirs?: ReadonlySet<string>;
};

async function detectSelfCliInvocationAtDepth(
  segments: readonly ExecCommandSegment[] | undefined,
  context: SelfCliDetectionContext,
  depth: number,
): Promise<ExecCommandSegment | null> {
  if (!segments || segments.length === 0) {
    return null;
  }
  for (const segment of segments) {
    if (isSelfCliCommandSegment(segment)) {
      return segment;
    }
  }
  if (depth >= MAX_DISPATCH_WRAPPER_DEPTH) {
    return null;
  }
  for (const segment of segments) {
    // `extractShellWrapperInlineCommand` (unlike its `...Bindable...` sibling) does not gate on
    // login/interactive shell startup ambiguity — that gate exists only to decide whether a
    // payload is safe to auto-trust and persist, which is irrelevant here: whatever text a shell
    // wrapper's `-c`/`-lc`/etc. flag carries is executed verbatim regardless of what its startup
    // files also do, so it always needs to be checked for a self-CLI hit too.
    const inlineCommand = extractShellWrapperInlineCommand(segment.argv);
    if (!inlineCommand) {
      continue;
    }
    const nestedEval = await evaluateShellAllowlistWithAuthorization({
      command: inlineCommand,
      allowlist: [],
      safeBins: context.safeBins ?? new Set(),
      cwd: context.cwd,
      env: context.env,
      platform: context.platform,
      trustedSafeBinDirs: context.trustedSafeBinDirs,
    });
    const hit = await detectSelfCliInvocationAtDepth(nestedEval.segments, context, depth + 1);
    if (hit) {
      return hit;
    }
  }
  return null;
}

/**
 * Scans resolved command segments — recursing into any shell-wrapper inline payload they carry
 * (`bash -lc "..."`, `sh -c "..."`, arbitrarily nested up to `MAX_DISPATCH_WRAPPER_DEPTH`) — for a
 * self-CLI invocation; returns the first hit, if any. This is the single shared recursion point
 * both the gateway and node exec hosts call through.
 */
export async function detectSelfCliInvocation(
  segments: readonly ExecCommandSegment[] | undefined,
  context: SelfCliDetectionContext = {},
): Promise<ExecCommandSegment | null> {
  return detectSelfCliInvocationAtDepth(segments, context, 0);
}
