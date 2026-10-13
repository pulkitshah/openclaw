import { describe, expect, it } from "vitest";
import { normalizeModifiers, parseKeyChord, scalePoint } from "./actions.js";

// normalizeKey is internal; exercise it through parseKeyChord's final segment.
const normalizeKey = (input: string) => parseKeyChord(input, "linux").key;

describe("cua-computer key normalization", () => {
  it.each([
    ["cmd+shift", "linux", ["meta", "shift"]],
    ["Super+Control+Option", "linux", ["meta", "ctrl", "alt"]],
    ["win+mod1", "linux", ["meta", "alt"]],
    ["cmd+shift", "darwin", ["cmd", "shift"]],
    ["Super+Control+Option", "darwin", ["cmd", "ctrl", "alt"]],
    ["win+mod1", "darwin", ["cmd", "alt"]],
    ["cmd+shift", "win32", ["win", "shift"]],
    ["Super+Control+Option", "win32", ["win", "ctrl", "alt"]],
  ] as const)("normalizes modifier aliases in %s on %s", (input, platform, expected) => {
    expect(normalizeModifiers(input, platform)).toEqual(expected);
  });

  it.each([
    ["Return", "enter"],
    ["Esc", "escape"],
    ["PgDn", "pagedown"],
    ["Home", "home"],
    ["F12", "f12"],
    ["z", "z"],
    ["Z", "z"],
    ["c", "c"],
  ])("normalizes key %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });

  it.each(["minus", "slash", "equal", "period", "comma", "semicolon"])(
    "rejects punctuation-alias key %s toward the type action",
    (input) => {
      expect(() => normalizeKey(input)).toThrow("COMPUTER_UNSUPPORTED_KEY");
    },
  );

  it("keeps letter keys usable in shortcut chords", () => {
    expect(parseKeyChord("cmd+c", "linux")).toEqual({ key: "c", modifiers: ["meta"] });
    expect(parseKeyChord("ctrl+c", "win32")).toEqual({ key: "c", modifiers: ["ctrl"] });
  });

  // The Windows driver reports the Win key as sent but never injects it, on
  // either route. A bare tap maps to the Start chord the driver does deliver.
  it.each(["win", "Super", "cmd", "meta"])(
    "delivers a bare %s tap on win32 as ctrl+escape",
    (input) => {
      expect(parseKeyChord(input, "win32")).toEqual({ key: "escape", modifiers: ["ctrl"] });
    },
  );

  it.each(["win+r", "Cmd+Shift+Left", "ctrl+win", "win+win"])(
    "refuses the undeliverable Win chord %s on win32",
    (input) => {
      expect(() => parseKeyChord(input, "win32")).toThrow(
        /COMPUTER_UNSUPPORTED_KEY: the Windows driver cannot inject the Win key/,
      );
    },
  );

  it("keeps a bare platform-key tap native on linux and darwin", () => {
    expect(parseKeyChord("win", "linux")).toEqual({ key: "meta", modifiers: [] });
    expect(parseKeyChord("win", "darwin")).toEqual({ key: "cmd", modifiers: [] });
  });

  // Digits and punctuation are shifted on some keyboard layouts, and cua-driver
  // drops that shift state, so they must be rejected toward the type action
  // rather than silently degraded.
  it.each(["1", "+", "*", ":", "_", "(", ".", "?", "é"])(
    "rejects layout-shifted key %s toward the type action",
    (input) => {
      expect(() => normalizeKey(input)).toThrow("COMPUTER_UNSUPPORTED_KEY");
    },
  );

  it("splits the last chord segment into the key", () => {
    expect(parseKeyChord("cmd+ctrl+Return", "linux")).toEqual({
      key: "enter",
      modifiers: ["meta", "ctrl"],
    });
  });

  it.each(["hyper", "ctrl+hyper"])("rejects unknown vocabulary in %s", (input) => {
    const operation = input.includes("+")
      ? () => parseKeyChord(input, "linux")
      : () => normalizeModifiers(input, "linux");
    expect(operation).toThrow("COMPUTER_UNSUPPORTED_KEY");
  });

  it("keeps rounded coordinates inside the native primary-display bounds", () => {
    expect(
      scalePoint(
        {
          id: "frame",
          referenceWidth: 1920,
          nativeWidth: 3840,
          nativeHeight: 2160,
          deliveredWidth: 1920,
          deliveredHeight: 1080,
          geometry: { width: 3840, height: 2160, scaleFactor: 1 },
        },
        1919.9,
        1079.9,
        "click",
      ),
    ).toEqual({ x: 3839, y: 2159 });
  });
});
