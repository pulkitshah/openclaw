import { describe, expect, it } from "vitest";
import { driver, execution } from "./commands.test-helpers.js";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";

// Observed on the office PC against SDK 0.23.2: the input landed (Start opened)
// but the shell's search window, not the taskbar, ended up in front.
const START_MENU_VERIFICATION_FAILURE =
  "foreground_unavailable: exact target HWND 0x100ec or a verified same-process post-action window was not foreground after the click (actual foreground HWND 0x301be)";
// Observed when the foreground lock denied activation: nothing was clicked.
const FOREGROUND_LOCK_FAILURE =
  "foreground_unavailable: Windows did not activate exact target HWND 0xb0d56 (actual foreground HWND 0x100ec); no mouse input was sent";

function windowDriver() {
  const native = driver();
  native.callTool.mockImplementation(async (name) => {
    if (name === "list_windows") {
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
    }
    if (name === "get_window_state") {
      return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
    }
    return cuaToolResult({});
  });
  return native;
}

async function observeWindow(computer: Awaited<ReturnType<typeof execution>>) {
  const listed = JSON.parse(await computer.act('{"action":"list_windows"}')) as {
    details: { windows: Array<{ windowRef: string }> };
  };
  const windowRef = listed.details.windows[0]!.windowRef;
  const observed = JSON.parse(
    await computer.act(JSON.stringify({ action: "get_window_state", windowRef })),
  ) as { observation: { observationId: string } };
  return { windowRef, observationId: observed.observation.observationId };
}

describe("cua-computer Windows foreground delivery", () => {
  it.each(["left_click", "type", "key"] as const)(
    "raises the target window before foreground %s on win32",
    async (action) => {
      const native = windowDriver();
      const computer = await execution(native.session, "win32");
      try {
        const target = await observeWindow(computer);
        const input =
          action === "type"
            ? { text: "hello" }
            : action === "key"
              ? { keys: "ctrl+s" }
              : { x: 20, y: 30 };
        await computer.act(
          JSON.stringify({ action, ...target, ...input, deliveryMode: "foreground" }),
        );
        const toolCalls = native.callTool.mock.calls.map(([name, args]) => [name, args]);
        const raiseIndex = toolCalls.findIndex(([name]) => name === "bring_to_front");
        expect(raiseIndex).toBeGreaterThan(-1);
        expect(toolCalls[raiseIndex]![1]).toEqual({ pid: 4242, window_id: 99 });
        expect(toolCalls[raiseIndex + 1]![0]).toBe(
          action === "left_click" ? "click" : action === "type" ? "type_text" : "press_key",
        );
      } finally {
        await computer.close("completion");
      }
    },
  );

  it.each([
    { platform: "win32", deliveryMode: "background" },
    { platform: "linux", deliveryMode: "foreground" },
    { platform: "darwin", deliveryMode: "foreground" },
  ] as const)(
    "does not raise for $deliveryMode delivery on $platform",
    async ({ platform, deliveryMode }) => {
      const native = windowDriver();
      const computer = await execution(native.session, platform);
      try {
        const target = await observeWindow(computer);
        await computer.act(
          JSON.stringify({ action: "left_click", ...target, x: 20, y: 30, deliveryMode }),
        );
        expect(native.callTool.mock.calls.map(([name]) => name)).not.toContain("bring_to_front");
      } finally {
        await computer.close("completion");
      }
    },
  );

  it("falls back to background delivery when Windows keeps the foreground on the shell", async () => {
    const native = windowDriver();
    native.callTool.mockImplementation(async (name) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_window_state") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
      }
      if (name === "bring_to_front") {
        // Observed when explorer owned the foreground: raised in z-order, not activated.
        return cuaToolResult(
          {},
          {
            isError: true,
            errorCode: "foreground_unavailable",
            text: "bring_to_front: exact target hwnd 0xb0d56 was raised in z-order, but Windows kept foreground on hwnd 0x100ec; foreground activation failed.",
          },
        );
      }
      return cuaToolResult({});
    });
    const computer = await execution(native.session, "win32");
    try {
      const target = await observeWindow(computer);
      const response = JSON.parse(
        await computer.act(
          JSON.stringify({
            action: "left_click",
            ...target,
            x: 20,
            y: 30,
            deliveryMode: "foreground",
          }),
        ),
      );
      expect(native.callTool).toHaveBeenLastCalledWith(
        "click",
        expect.objectContaining({ pid: 4242, window_id: 99, delivery_mode: "background" }),
        undefined,
      );
      expect(response).toMatchObject({
        ok: true,
        details: {
          foregroundFallback: expect.stringContaining("Windows kept foreground on hwnd 0x100ec"),
        },
      });
    } finally {
      await computer.close("completion");
    }
  });

  it("surfaces a failed raise instead of sending input the lock would drop", async () => {
    const native = windowDriver();
    native.callTool.mockImplementation(async (name) => {
      if (name === "list_windows") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.listWindows);
      }
      if (name === "get_window_state") {
        return cuaToolResult(CUA_DRIVER_CONTRACT_FIXTURES.windowState, { image: true });
      }
      if (name === "bring_to_front") {
        return cuaToolResult({}, { isError: true, text: "bring_to_front: window is gone" });
      }
      return cuaToolResult({});
    });
    const computer = await execution(native.session, "win32");
    try {
      const target = await observeWindow(computer);
      await expect(
        computer.act(
          JSON.stringify({
            action: "left_click",
            ...target,
            x: 20,
            y: 30,
            deliveryMode: "foreground",
          }),
        ),
      ).rejects.toThrow("COMPUTER_DRIVER_ERROR: bring_to_front: window is gone");
      expect(native.callTool.mock.calls.map(([name]) => name)).not.toContain("click");
    } finally {
      await computer.close("completion");
    }
  });
});

describe("cua-computer Windows desktop verification", () => {
  async function desktopClick(platform: NodeJS.Platform, text: string) {
    const native = driver();
    // The driver reports these as text-only errors: no errorCode on the wire.
    native.click.mockResolvedValue(cuaToolResult({}, { isError: true, text }));
    const computer = await execution(native.session, platform);
    try {
      const screen = JSON.parse(await computer.snapshot('{"format":"png","maxWidth":100}'));
      return await computer.act(
        JSON.stringify({
          action: "left_click",
          x: 10,
          y: 20,
          displayFrameId: screen.displayFrameId,
          refWidth: screen.width,
        }),
      );
    } finally {
      await computer.close("completion");
    }
  }

  it("reports a delivered shell-surface click as unverifiable on win32", async () => {
    const response = JSON.parse(await desktopClick("win32", START_MENU_VERIFICATION_FAILURE));
    expect(response).toMatchObject({
      ok: true,
      effect: "unverifiable",
      details: { route: "global_input", scope: "desktop" },
    });
  });

  it("keeps the foreground-lock refusal an error because nothing was clicked", async () => {
    await expect(desktopClick("win32", FOREGROUND_LOCK_FAILURE)).rejects.toThrow(
      "COMPUTER_DRIVER_ERROR: foreground_unavailable: Windows did not activate",
    );
  });

  it("does not reinterpret driver verdicts on other platforms", async () => {
    await expect(desktopClick("linux", START_MENU_VERIFICATION_FAILURE)).rejects.toThrow(
      "COMPUTER_DRIVER_ERROR: foreground_unavailable",
    );
  });
});
