// Relaunches the gateway through the managed Windows scheduled task.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { quoteCmdScriptArg } from "../daemon/cmd-argv.js";
import { resolveGatewayWindowsTaskName } from "../daemon/constants.js";
import { renderCmdRestartLogSetup } from "../daemon/restart-logs.js";
import { resolveTaskScriptPath } from "../daemon/schtasks.js";
import { formatErrorMessage } from "./errors.js";
import type { RestartAttempt } from "./restart.types.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { getWindowsCmdExePath } from "./windows-install-roots.js";
import { encodeWindowsLauncherScript } from "./windows-launcher-encoding.js";

const TASK_RESTART_RETRY_LIMIT = 12;
const TASK_RESTART_RETRY_DELAY_SEC = 1;
// The Gateway hands off and then exits; its task instance stays "Running" until the task
// supervisor's extinction join finishes. Wait past the supervisor's 330 s stop budget before
// treating the instance as stale (a job that never empties kept one alive for minutes live).
const TASK_STOP_WAIT_LIMIT = 72;
const TASK_STOP_WAIT_DELAY_SEC = 5;

function quotePowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

function buildScheduledTaskRestartScript(params: {
  quotedLogPath: string;
  setupLines: string[];
  taskName: string;
  taskScriptPath?: string;
}): string {
  const { quotedLogPath, setupLines, taskName, taskScriptPath } = params;
  const quotedTaskName = quoteCmdScriptArg(taskName);
  const quotedTaskLiteral = quotePowerShellSingleQuotedLiteral(taskName);
  // The handoff is written while the old Gateway still runs, so its task instance shows
  // "Running" (live 2026-10-16: the helper read that as "already restarted", quit, and the
  // desk stayed down). Exit codes: 0 = that instance still runs, 1 = not running, 2 = an
  // instance newer than this handoff runs (another restart path won; leave it alone).
  const handoffSince = new Date().toISOString();
  const queryTaskStateCommand = [
    `$task = Get-ScheduledTask -TaskName ${quotedTaskLiteral} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task -or $task.State -ne 'Running') { exit 1 }",
    `$info = Get-ScheduledTaskInfo -TaskName ${quotedTaskLiteral} -ErrorAction SilentlyContinue`,
    `if ($null -ne $info -and $info.LastRunTime -gt [DateTime]::Parse('${handoffSince}')) { exit 2 }`,
    "exit 0",
  ].join("; ");
  const quotedQueryTaskStateCommand = quoteCmdScriptArg(queryTaskStateCommand);
  const lines = [
    "@echo off",
    "setlocal",
    ...setupLines,
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] vasudev restart attempt source=windows-task-handoff target=${quotedTaskName}`,
    `schtasks /Query /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    "if errorlevel 1 goto fallback",
    "set /a waits=0",
    ":await",
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotedQueryTaskStateCommand} >nul 2>&1`,
    "if errorlevel 2 goto cleanup",
    "if errorlevel 1 goto run",
    "set /a waits+=1",
    `if %waits% GEQ ${TASK_STOP_WAIT_LIMIT} goto stale`,
    `timeout /t ${TASK_STOP_WAIT_DELAY_SEC} /nobreak >nul`,
    "goto await",
    ":stale",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] vasudev restart ending stale task instance source=windows-task-handoff`,
    `schtasks /End /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    `timeout /t ${TASK_STOP_WAIT_DELAY_SEC} /nobreak >nul`,
    ":run",
    "set /a attempts=0",
    ":retry",
    `schtasks /Run /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
    "if not errorlevel 1 goto cleanup",
    "set /a attempts+=1",
    `if %attempts% GEQ ${TASK_RESTART_RETRY_LIMIT} goto fallback`,
    `timeout /t ${TASK_RESTART_RETRY_DELAY_SEC} /nobreak >nul`,
    "goto retry",
    ":fallback",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] vasudev restart fallback source=windows-task-handoff`,
  ];
  if (taskScriptPath) {
    const quotedScript = quoteCmdScriptArg(taskScriptPath);
    const quotedCmd = quoteCmdScriptArg(getWindowsCmdExePath());
    lines.push(
      `if exist ${quotedScript} (`,
      `  start "" /min ${quotedCmd} /d /c ${quotedScript}`,
      ")",
    );
  }
  lines.push(
    ":cleanup",
    `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] vasudev restart finished source=windows-task-handoff`,
    'del "%~f0" >nul 2>&1',
  );
  return lines.join("\r\n");
}

export function relaunchGatewayScheduledTask(env: NodeJS.ProcessEnv = process.env): RestartAttempt {
  const taskName = resolveWindowsTaskName(env);
  const taskScriptPath = resolveTaskScriptPath(env);
  const scriptPath = path.join(
    resolvePreferredOpenClawTmpDir(),
    `openclaw-schtasks-restart-${randomUUID()}.cmd`,
  );
  const quotedScriptPath = quoteCmdScriptArg(scriptPath);
  const restartLog = renderCmdRestartLogSetup({ ...process.env, ...env });
  try {
    // The script embeds host paths and the task name; cmd.exe decodes it with
    // the console code page, so plain UTF-8 garbles CJK content (#107416).
    fs.writeFileSync(
      scriptPath,
      encodeWindowsLauncherScript({
        format: "cmd",
        content: `${buildScheduledTaskRestartScript({
          quotedLogPath: restartLog.quotedLogPath,
          setupLines: restartLog.lines,
          taskName,
          taskScriptPath,
        })}\r\n`,
      }),
    );
    const cmdExePath = getWindowsCmdExePath();
    const child = spawn(cmdExePath, ["/d", "/s", "/c", quotedScriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return {
      ok: true,
      method: "schtasks",
      tried: [`schtasks /Run /TN "${taskName}"`, `${cmdExePath} /d /s /c ${quotedScriptPath}`],
    };
  } catch (err) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup; keep the original restart failure.
    }
    return {
      ok: false,
      method: "schtasks",
      detail: formatErrorMessage(err),
      tried: [`schtasks /Run /TN "${taskName}"`],
    };
  }
}
