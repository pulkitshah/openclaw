/**
 * Gmail Watcher Service
 *
 * Automatically starts `gog gmail watch serve` when the gateway starts,
 * if hooks.gmail is configured with an account.
 */

import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { probePortUsage } from "../infra/ports-probe.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { releaseChildProcessOutputAfterExit } from "../process/child-process.js";
import { formatCommandResult } from "../process/command-error.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { killProcessTree } from "../process/kill-tree.js";
import { hasBinary } from "../skills/loading/config.js";
import { resolveGmailHookAccounts } from "./gmail-accounts.js";
import { ensureTailscaleEndpoint } from "./gmail-setup-utils.js";
import { isAddressInUseError } from "./gmail-watcher-errors.js";
import {
  buildGogWatchServeLogArgs,
  buildGogWatchServeArgs,
  buildGogWatchStartArgs,
  findGmailServeBindCollision,
  type GmailHookRuntimeConfig,
  resolveGogExecutable,
  resolveGogServeInvocation,
  resolveGmailHookRuntimeConfig,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-watcher");
const GMAIL_WATCHER_STDERR_TAIL_CHARS = 512;

type GmailWatcherState = {
  watcherProcess: ChildProcess | null;
  renewInterval: ReturnType<typeof setInterval> | null;
  renewalInFlight: Promise<boolean> | null;
  renewalAbortController: AbortController | null;
  shuttingDown: boolean;
  currentConfig: GmailHookRuntimeConfig | null;
  respawnTimeout: ReturnType<typeof setTimeout> | null;
};

/** One `gog serve` process per mailbox. Keyed by account id, so starting or stopping one mailbox
 *  never disturbs another; `stopGmailWatcher()` with no argument still stops every one. */
const watchers = new Map<string, GmailWatcherState>();

function watcherFor(accountId: string): GmailWatcherState {
  let state = watchers.get(accountId);
  if (!state) {
    state = {
      watcherProcess: null,
      renewInterval: null,
      renewalInFlight: null,
      renewalAbortController: null,
      shuttingDown: false,
      currentConfig: null,
      respawnTimeout: null,
    };
    watchers.set(accountId, state);
  }
  return state;
}

/**
 * Start the Gmail watch (registers with Gmail API)
 */
async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
  options: { signal?: AbortSignal } = {},
): Promise<boolean> {
  const args = [resolveGogExecutable(), ...buildGogWatchStartArgs(cfg)];
  try {
    const result = await runCommandWithTimeout(args, {
      timeoutMs: 120_000,
      signal: options.signal,
    });
    if (result.code !== 0) {
      log.error(formatCommandResult("gog gmail watch start", result));
      return false;
    }
    log.info(`watch started for ${cfg.account}`);
    return true;
  } catch (err) {
    log.error(`watch start error: ${String(err)}`);
    return false;
  }
}

/**
 * Spawn the gog gmail watch serve process
 */
function spawnGogServe(cfg: GmailHookRuntimeConfig, state: GmailWatcherState): ChildProcess {
  const args = buildGogWatchServeArgs(cfg);
  log.info(`starting gog ${buildGogWatchServeLogArgs(cfg).join(" ")}`);
  let addressInUse = false;
  let spawnFailed = false;
  // Carry a bounded tail so bind markers split across stderr chunks survive until close.
  let stderrTail = "";
  const invocation = resolveGogServeInvocation(args);

  const child = spawn(invocation.command, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on Unix so killProcessTree can reach descendants on shutdown.
    detached: process.platform !== "win32",
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  child.stdout?.on("error", (err) => {
    log.error(`gog stdout error: ${String(err)}`);
  });
  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      log.info(`[gog] ${line}`);
    }
  });

  child.stderr?.on("error", (err) => {
    log.error(`gog stderr error: ${String(err)}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const chunk = data.toString();
    // Classify before truncation so a marker completed across the retention boundary survives.
    const combined = stderrTail + chunk;
    if (!addressInUse && isAddressInUseError(combined)) {
      addressInUse = true;
    }
    stderrTail = combined.slice(-GMAIL_WATCHER_STDERR_TAIL_CHARS);
    const line = chunk.trim();
    if (!line) {
      return;
    }
    log.warn(`[gog] ${line}`);
  });

  child.on("error", (err) => {
    // Failed spawn emits close without a pid; later errors on a running child remain retryable.
    if (child.pid === undefined) {
      spawnFailed = true;
    }
    log.error(`gog process error: ${String(err)}`);
  });

  const releaseOutput = releaseChildProcessOutputAfterExit(child);
  child.once("exit", () => {
    // The detached POSIX group remains ours after its leader dies. Windows
    // taskkill requires a live root PID; only bound inherited-pipe drain there.
    if (
      !state.shuttingDown &&
      state.watcherProcess === child &&
      process.platform !== "win32" &&
      child.pid
    ) {
      killProcessTree(child.pid, { force: true, detached: true });
    }
  });

  // `close` follows bounded stdio drain, so late stderr still classifies bind failures.
  child.once("close", (code, signal) => {
    releaseOutput();
    if (state.shuttingDown || state.watcherProcess !== child) {
      return;
    }
    if (spawnFailed) {
      state.watcherProcess = null;
      return;
    }
    if (addressInUse) {
      log.warn(
        "gog serve failed to bind (address already in use); stopping restarts. " +
          "Another watcher is likely running. Set OPENCLAW_SKIP_GMAIL_WATCHER=1 or stop the other process.",
      );
      state.watcherProcess = null;
      return;
    }
    log.warn(`gog exited (code=${code}, signal=${signal}); restarting in 5s`);
    state.watcherProcess = null;
    state.respawnTimeout = setTimeout(() => {
      state.respawnTimeout = null;
      if (state.shuttingDown || !state.currentConfig) {
        return;
      }
      state.watcherProcess = spawnGogServe(state.currentConfig, state);
    }, 5000);
  });

  return child;
}

/**
 * Signal the gog process tree to exit gracefully (SIGTERM, SIGKILL after 3 s)
 * and resolve on exit/close/error or a final 8 s safety timeout.
 */
function settleProcess(proc: ChildProcess): Promise<void> {
  // A Windows root PID can be reused after exit, even while inherited pipes
  // delay close. The spawn owner's bounded drain releases those pipes safely.
  if (process.platform === "win32" && (proc.exitCode != null || proc.signalCode != null)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    let processSettled = false;
    let graceElapsed = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      if (finalTimeout) {
        clearTimeout(finalTimeout);
      }
      proc.removeListener("exit", settleAfterEscalation);
      proc.removeListener("close", settleAfterEscalation);
      proc.removeListener("error", settleAfterEscalation);
      resolve();
    };
    const settleAfterEscalation = () => {
      processSettled = true;
      if (graceElapsed) {
        settle();
      }
    };
    const finalTimeout = setTimeout(() => {
      if (!settled) {
        log.warn("gog process did not exit after SIGKILL; giving up");
        settle();
      }
    }, 8_000);

    proc.on("exit", settleAfterEscalation);
    proc.on("close", settleAfterEscalation);
    proc.on("error", settleAfterEscalation);

    // killProcessTree sends SIGTERM to the process group (Unix) or uses taskkill /T
    // (Windows) and escalates to SIGKILL after graceMs, reaching any descendants
    // spawned by gog that plain proc.kill() would miss.
    if (typeof proc.pid === "number") {
      const graceMs = 3_000;
      killProcessTree(proc.pid, {
        graceMs,
        detached: process.platform !== "win32",
      });
      // killProcessTree owns escalation but intentionally unrefs its timer.
      // Keep shutdown referenced until that escalation has had a chance to run.
      graceTimer = setTimeout(() => {
        graceElapsed = true;
        if (processSettled) {
          settle();
        }
      }, graceMs + 25);
    } else {
      // pid absent means spawn never started; direct kill clears any lingering state.
      try {
        proc.kill("SIGTERM");
      } catch {
        /* process may not exist */
      }
      graceElapsed = true;
    }
  });
}

async function stopPeriodicRenewal(state: GmailWatcherState): Promise<void> {
  if (state.renewInterval) {
    clearInterval(state.renewInterval);
    state.renewInterval = null;
  }

  const renewal = state.renewalInFlight;
  const controller = state.renewalAbortController;
  if (!renewal) {
    state.renewalAbortController = null;
    return;
  }

  controller?.abort();
  await renewal;
  if (state.renewalInFlight === renewal) {
    state.renewalInFlight = null;
  }
  if (state.renewalAbortController === controller) {
    state.renewalAbortController = null;
  }
}

type GmailWatcherStartResult = {
  started: boolean;
  reason?: string;
};

type GmailWatcherStartOptions = {
  signal?: AbortSignal;
};

function cancelledGmailWatcherStart(
  expectedConfig: GmailHookRuntimeConfig,
  state: GmailWatcherState,
): GmailWatcherStartResult {
  if (state.currentConfig === expectedConfig) {
    state.currentConfig = null;
  }
  return { started: false, reason: "startup cancelled" };
}

/**
 * Start the Gmail watcher service: one `gog serve` process per configured mailbox.
 * Called automatically by the gateway if hooks.gmail is configured.
 */
export async function startGmailWatcher(
  cfg: OpenClawConfig,
  options: GmailWatcherStartOptions = {},
): Promise<GmailWatcherStartResult> {
  // Check if hooks are enabled
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  const accounts = resolveGmailHookAccounts(cfg);
  if (accounts.length === 0) {
    return { started: false, reason: "no gmail account configured" };
  }

  // Check if gog is available
  if (!hasBinary("gog")) {
    return { started: false, reason: "gog binary not found" };
  }

  // The common case (and every already-deployed config) has exactly one mailbox. Keep that
  // path's result shape byte-identical — no per-account prefix on the reason string — so callers
  // matching specific reason text (gmail-watcher-lifecycle.ts, existing tests) keep working
  // unchanged.
  const onlyAccount = accounts.length === 1 ? accounts[0] : undefined;
  if (onlyAccount) {
    const resolved = resolveGmailHookRuntimeConfig(cfg, { accountId: onlyAccount.accountId });
    if (!resolved.ok) {
      return { started: false, reason: resolved.error };
    }
    return startGmailWatcherService(resolved.value, options);
  }

  // Multiple mailboxes: resolve every account first — one misconfigured account must not stop the
  // others — then reject the whole set if any two resolve to the exact same (bind, port). Two
  // named accounts left on the shared default port is the ordinary, expected two-account mistake,
  // not an edge case; catching it here means neither account's `gog serve` ever races to bind the
  // same address, so the second one's failure is never silently a warn log nobody sees.
  const reasons: string[] = [];
  const okConfigs: GmailHookRuntimeConfig[] = [];
  for (const { accountId } of accounts) {
    const resolved = resolveGmailHookRuntimeConfig(cfg, { accountId });
    if (!resolved.ok) {
      reasons.push(`${accountId}: ${resolved.error}`);
      continue;
    }
    okConfigs.push(resolved.value);
  }

  const collision = findGmailServeBindCollision(okConfigs);
  if (collision) {
    return {
      started: false,
      reason:
        `gmail accounts "${collision.first}" and "${collision.second}" both resolve to serve ` +
        `${collision.bind}:${collision.port}; set hooks.gmail.accounts.<id>.serve.port to a ` +
        "distinct port for each mailbox",
    };
  }

  // A distinct configured port is not proof the port is actually free — something outside this
  // desk's own Gmail accounts (or a leftover process) may already hold it. Probe before spawning
  // so that failure is a reported start failure for that one account, not a warn log discovered
  // only by reading logs after mail silently stops arriving.
  let started = false;
  for (const runtimeConfig of okConfigs) {
    const usage = await probePortUsage(runtimeConfig.serve.port, [runtimeConfig.serve.bind]);
    if (usage === "busy") {
      reasons.push(
        `${runtimeConfig.accountId}: gmail serve bind unavailable: ` +
          `${runtimeConfig.serve.bind}:${runtimeConfig.serve.port} is already in use`,
      );
      continue;
    }
    const result = await startGmailWatcherService(runtimeConfig, options);
    if (result.started) {
      started = true;
    } else {
      reasons.push(`${runtimeConfig.accountId}: ${result.reason ?? "not started"}`);
    }
  }
  // A partial success (some accounts started, at least one did not) still reports `reason`
  // alongside `started: true` — a bind failure or resolution error must never be silently dropped
  // just because a sibling mailbox happened to work.
  return {
    started,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  };
}

/** Start the shared watcher lifecycle after the caller resolves config and prerequisites. */
export async function startGmailWatcherService(
  runtimeConfig: GmailHookRuntimeConfig,
  options: GmailWatcherStartOptions = {},
): Promise<GmailWatcherStartResult> {
  const state = watcherFor(runtimeConfig.accountId);
  if (options.signal?.aborted) {
    return cancelledGmailWatcherStart(runtimeConfig, state);
  }
  state.currentConfig = runtimeConfig;

  // Stop any existing watcher before doing async setup so a re-entry
  // does not orphan the old serve process or leave a dangling timer.
  // This must run before Tailscale/watch-start to prevent the old
  // process from exiting and queuing a respawn during async work.
  if (
    state.watcherProcess ||
    state.renewInterval ||
    state.renewalInFlight ||
    state.respawnTimeout
  ) {
    state.shuttingDown = true;
    if (state.respawnTimeout) {
      clearTimeout(state.respawnTimeout);
      state.respawnTimeout = null;
    }
    await stopPeriodicRenewal(state);
    if (state.watcherProcess) {
      const oldProcess = state.watcherProcess;
      state.watcherProcess = null;
      await settleProcess(oldProcess);
    }
    state.shuttingDown = false;
  }

  // Set up Tailscale endpoint if needed
  if (runtimeConfig.tailscale.mode !== "off") {
    try {
      await ensureTailscaleEndpoint({
        mode: runtimeConfig.tailscale.mode,
        path: runtimeConfig.tailscale.path,
        port: runtimeConfig.serve.port,
        signal: options.signal,
        target: runtimeConfig.tailscale.target,
      });
      log.info(
        `tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`,
      );
      if (options.signal?.aborted) {
        return cancelledGmailWatcherStart(runtimeConfig, state);
      }
    } catch (err) {
      if (options.signal?.aborted) {
        return cancelledGmailWatcherStart(runtimeConfig, state);
      }
      log.error(`tailscale setup failed: ${String(err)}`);
      return {
        started: false,
        reason: `tailscale setup failed: ${String(err)}`,
      };
    }
  }

  // Start the Gmail watch (register with Gmail API)
  const watchStarted = await startGmailWatch(runtimeConfig, { signal: options.signal });
  if (options.signal?.aborted) {
    return cancelledGmailWatcherStart(runtimeConfig, state);
  }
  if (!watchStarted) {
    log.warn("gmail watch start failed, but continuing with serve");
  }

  // Spawn the gog serve process
  state.shuttingDown = false;
  state.watcherProcess = spawnGogServe(runtimeConfig, state);
  const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
  state.renewInterval = setInterval(() => {
    if (state.shuttingDown || state.renewalInFlight) {
      return;
    }
    const controller = new AbortController();
    state.renewalAbortController = controller;
    const renewal = startGmailWatch(runtimeConfig, { signal: controller.signal }).finally(() => {
      if (state.renewalInFlight === renewal) {
        state.renewalInFlight = null;
      }
      if (state.renewalAbortController === controller) {
        state.renewalAbortController = null;
      }
    });
    state.renewalInFlight = renewal;
  }, renewMs);

  log.info(
    `gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
  );

  return { started: true };
}

/**
 * Stop the Gmail watcher service for one account, or every running account when `accountId` is
 * omitted (the gateway's own shutdown path, `src/gateway/server-close.ts`, always omits it).
 */
export async function stopGmailWatcher(accountId?: string): Promise<void> {
  const ids = accountId ? [accountId] : [...watchers.keys()];
  for (const id of ids) {
    await stopOneGmailWatcher(id);
  }
}

async function stopOneGmailWatcher(accountId: string): Promise<void> {
  const state = watcherFor(accountId);
  state.shuttingDown = true;

  if (state.respawnTimeout) {
    clearTimeout(state.respawnTimeout);
    state.respawnTimeout = null;
  }
  await stopPeriodicRenewal(state);

  if (state.watcherProcess) {
    log.info("stopping gmail watcher");
    const proc = state.watcherProcess;
    state.watcherProcess = null;
    await settleProcess(proc);
  }

  state.currentConfig = null;
  log.info("gmail watcher stopped");
  // Drop the entry so a churned-away account does not leak an empty state object forever, and so
  // a future start for this id begins from a clean slate.
  watchers.delete(accountId);
}
