// Daemon runtime hint tests cover platform-specific daemon guidance.
import { describe, expect, it } from "vitest";
import { buildPlatformRuntimeLogHints, buildPlatformServiceStartHints } from "./runtime-hints.js";

describe("buildPlatformRuntimeLogHints", () => {
  it("renders launchd log hints on darwin", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "darwin",
        env: {
          HOME: "/Users/test",
          OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
          OPENCLAW_LOG_PREFIX: "gateway",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "Vasudev Gateway",
      }),
    ).toEqual([
      "Launchd stdout and stderr (if installed): /Users/test/Library/Logs/openclaw/gateway.log",
      "Restart attempts: /tmp/openclaw-state/logs/gateway-restart.log",
    ]);
  });

  it("renders systemd and windows hints by platform", () => {
    expect(
      buildPlatformRuntimeLogHints({
        platform: "linux",
        env: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "Vasudev Gateway",
      }),
    ).toEqual([
      "Logs: journalctl --user -u openclaw-gateway.service -n 200 --no-pager",
      "Restart attempts: /tmp/openclaw-state/logs/gateway-restart.log",
    ]);
    expect(
      buildPlatformRuntimeLogHints({
        platform: "win32",
        env: {
          OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
        },
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "Vasudev Gateway",
      }),
    ).toEqual([
      'Logs: schtasks /Query /TN "Vasudev Gateway" /V /FO LIST',
      "Restart attempts: /tmp/openclaw-state/logs/gateway-restart.log",
    ]);
  });
});

describe("buildPlatformServiceStartHints", () => {
  it("builds platform-specific service start hints", () => {
    expect(
      buildPlatformServiceStartHints({
        platform: "darwin",
        installHint: "vasudev gateway install",
        startCommand: "vasudev gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.openclaw.gateway.plist",
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "Vasudev Gateway",
      }),
    ).toEqual([
      "vasudev gateway install",
      "vasudev gateway",
      "launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.openclaw.gateway.plist",
    ]);
    expect(
      buildPlatformServiceStartHints({
        platform: "linux",
        installHint: "vasudev gateway install",
        startCommand: "vasudev gateway",
        launchAgentPlistPath: "~/Library/LaunchAgents/com.openclaw.gateway.plist",
        systemdServiceName: "openclaw-gateway",
        windowsTaskName: "Vasudev Gateway",
      }),
    ).toEqual([
      "vasudev gateway install",
      "vasudev gateway",
      "systemctl --user start openclaw-gateway.service",
    ]);
  });
});
