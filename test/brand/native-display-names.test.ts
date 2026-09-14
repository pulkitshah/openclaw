import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// Task 5 of the vasudev-theme SDD plan: native app *display names* and icon
// *sources* move to Vasudev while every installer-keyed identifier (bundle
// ids, package names, scheme names, entitlements, service labels, URL types)
// stays on `openclaw`/`ai.openclaw.*` so upgrades, deep links, and app-group
// sharing keep working. This guard fails if a human-visible name reverts to
// OpenClaw, and just as importantly if a keyed identifier ever gets swapped.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

/** Minimal `<key>Name</key>\n<string>Value</string>` reader — plists are XML,
 * but the repo carries no plist parser and these files are tiny; a real
 * parser would be overkill for a handful of key/value pairs. */
function plistString(xml: string, key: string): string {
  const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "u");
  const match = xml.match(pattern);
  const value = match?.[1];
  if (value === undefined) {
    throw new Error(`plist key ${key} not found`);
  }
  return value;
}

/** An xcodegen target's `info.properties` block, as read from project.yml. */
type XcodegenTarget = { info: { properties: Record<string, unknown> } };

/** `targets` is keyed by target name with no static guarantee a given name
 * exists, so `noUncheckedIndexedAccess` types the lookup as possibly
 * `undefined`; fail fast with the missing name instead of a TS18048 access. */
function requireTarget(
  targets: Record<string, XcodegenTarget | undefined>,
  name: string,
): XcodegenTarget {
  const target = targets[name];
  if (!target) {
    throw new Error(`xcodegen target ${name} not found in project.yml`);
  }
  return target;
}

/** Reads a PNG's width/height/color-type straight from its IHDR chunk
 * (bytes 16-24), so the test can prove a size was actually rendered rather
 * than hand-copied. Color type 6 = truecolor+alpha (adaptive-icon layers). */
function pngHeader(relativePath: string): { width: number; height: number; colorType: number } {
  const bytes = readFileSync(path.join(repoRoot, relativePath));
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    colorType: bytes.readUInt8(25),
  };
}

describe("native app display names say Vasudev", () => {
  it("macOS Info.plist", () => {
    const plist = read("apps/macos/Sources/OpenClaw/Resources/Info.plist");
    expect(plistString(plist, "CFBundleDisplayName")).toBe("Vasudev");
    expect(plistString(plist, "CFBundleName")).toBe("Vasudev");
    // Keyed identifiers the OS/updater/deep-link handler rely on: unchanged.
    expect(plistString(plist, "CFBundleIdentifier")).toBe("ai.openclaw.mac");
    expect(plistString(plist, "CFBundleURLName")).toBe("ai.openclaw.mac.deeplink");
    expect(plist).toMatch(/<string>openclaw<\/string>/u);
  });

  it("Linux Tauri productName and window title", () => {
    const conf = JSON.parse(read("apps/linux/src-tauri/tauri.conf.json"));
    expect(conf.productName).toBe("Vasudev");
    expect(conf.app.windows[0].title).toBe("Vasudev");
    // Keyed identifiers: the tauri bundle id and deep-link scheme.
    expect(conf.identifier).toBe("ai.openclaw.linux");
    expect(conf.plugins["deep-link"].desktop.schemes).toContain("openclaw");
  });

  it("iOS/watchOS Xcodegen project.yml (the source xcodegen writes Info.plist from)", () => {
    const project = parseYaml(read("apps/ios/project.yml")) as {
      targets: Record<string, XcodegenTarget | undefined>;
    };
    expect(requireTarget(project.targets, "OpenClaw").info.properties.CFBundleDisplayName).toBe(
      "Vasudev",
    );
    expect(
      requireTarget(project.targets, "OpenClawShareExtension").info.properties.CFBundleDisplayName,
    ).toBe("Vasudev Share");
    expect(
      requireTarget(project.targets, "OpenClawActivityWidget").info.properties.CFBundleDisplayName,
    ).toBe("Vasudev Activity");
    expect(
      requireTarget(project.targets, "OpenClawWatchApp").info.properties.CFBundleDisplayName,
    ).toBe("Vasudev");
  });

  it("iOS/watchOS generated Info.plist files (checked in; xcodegen writes these from project.yml)", () => {
    const targets = [
      { file: "apps/ios/Sources/Info.plist", displayName: "Vasudev" },
      { file: "apps/ios/ShareExtension/Info.plist", displayName: "Vasudev Share" },
      { file: "apps/ios/ActivityWidget/Info.plist", displayName: "Vasudev Activity" },
      { file: "apps/ios/WatchApp/Info.plist", displayName: "Vasudev" },
    ];
    for (const { file, displayName } of targets) {
      const plist = read(file);
      expect(plistString(plist, "CFBundleDisplayName")).toBe(displayName);
      // The bundle identifier stays a build-setting placeholder, resolved at
      // build time from apps/ios/Config/Signing.xcconfig's ai.openclawfoundation.app.
      expect(plistString(plist, "CFBundleIdentifier")).toBe("$(PRODUCT_BUNDLE_IDENTIFIER)");
    }
    // The bundle id these placeholders resolve to still says openclaw.
    const signing = read("apps/ios/Config/Signing.xcconfig");
    expect(signing).toMatch(/OPENCLAW_APP_BUNDLE_ID\s*=\s*ai\.openclawfoundation\.app/u);
  });

  it("Android app_name string resources (main app, debug, and wear)", () => {
    const cases: Array<[string, string]> = [
      ["apps/android/app/src/main/res/values/strings.xml", "Vasudev Node"],
      ["apps/android/app/src/debug/res/values/strings.xml", "Vasudev Dev"],
      ["apps/android/app/src/main/res/values-fr/strings.xml", "Vasudev Node"],
      ["apps/android/wear/src/main/res/values/strings.xml", "Vasudev"],
      ["apps/android/wear/src/debug/res/values/strings.xml", "Vasudev Dev"],
    ];
    for (const [file, expected] of cases) {
      const match = read(file).match(/<string name="app_name"[^>]*>"?([^"<]+)"?<\/string>/u);
      expect(match?.[1]).toBe(expected);
    }
    // Every other OpenClaw string in the same files is untouched: only the
    // display name changed, not in-app copy.
    const wearStrings = read("apps/android/wear/src/main/res/values/strings.xml");
    expect(wearStrings).toMatch(/notification_channel_name">OpenClaw replies</u);
    // Keyed identifiers: unchanged Android application ids/namespaces.
    const appGradle = read("apps/android/app/build.gradle.kts");
    expect(appGradle).toMatch(/namespace = "ai\.openclaw\.app"/u);
    const wearGradle = read("apps/android/wear/build.gradle.kts");
    expect(wearGradle).toMatch(/applicationId = "ai\.openclaw\.app"/u);
  });
});

describe("native app icon sources are the Vasudev orb", () => {
  const LOBSTER_MARK = /lobster|crab/iu;
  // A signature unique to assets/brand/orb.svg's gradient stops.
  const ORB_SIGNATURE = /stop-color="#16c79a"/u;

  it("macOS Icon Composer source (Icon.icon)", () => {
    const svg = read("apps/macos/Icon.icon/Assets/molty.svg");
    expect(svg).not.toMatch(LOBSTER_MARK);
    expect(svg).toMatch(ORB_SIGNATURE);
  });

  it("Linux Tauri vector sources", () => {
    for (const file of [
      "apps/linux/src-tauri/icons/icon.svg",
      "apps/linux/src-tauri/icons/icon-tile.svg",
    ]) {
      const svg = read(file);
      expect(svg).not.toMatch(LOBSTER_MARK);
      expect(svg).toMatch(ORB_SIGNATURE);
    }
  });

  it("macOS tray template stays the CritterIconRenderer silhouette (not a brand icon)", () => {
    // This is a functional monochrome template image macOS renders from its
    // alpha channel alone, geometry-matched to the native app's
    // CritterIconRenderer at rest. It is deliberately left out of this
    // task's icon-source swap; Task 5 only replaces the app icon sets.
    const svg = read("apps/linux/src-tauri/icons/tray-template.svg");
    expect(svg).toMatch(/CritterIconRenderer/u);
  });

  it("Linux Tauri bundle icon raster set was regenerated at the right sizes", () => {
    expect(pngHeader("apps/linux/src-tauri/icons/32x32.png")).toMatchObject({
      width: 32,
      height: 32,
    });
    expect(pngHeader("apps/linux/src-tauri/icons/128x128.png")).toMatchObject({
      width: 128,
      height: 128,
    });
    expect(pngHeader("apps/linux/src-tauri/icons/128x128@2x.png")).toMatchObject({
      width: 256,
      height: 256,
    });
    expect(pngHeader("apps/linux/src-tauri/icons/icon.png")).toMatchObject({
      width: 512,
      height: 512,
    });
  });

  it("iOS app icon marketing size was regenerated", () => {
    for (const dir of ["AppIcon.appiconset", "AppIconDebug.appiconset"]) {
      const header = pngHeader(`apps/ios/Sources/Assets.xcassets/${dir}/1024.png`);
      expect(header).toMatchObject({ width: 1024, height: 1024 });
    }
  });

  it("Android legacy launcher icons were regenerated at their declared densities", () => {
    const densities: Array<[string, number]> = [
      ["mipmap-mdpi", 48],
      ["mipmap-hdpi", 72],
      ["mipmap-xhdpi", 96],
      ["mipmap-xxhdpi", 144],
      ["mipmap-xxxhdpi", 192],
    ];
    for (const [dir, size] of densities) {
      const header = pngHeader(`apps/android/app/src/main/res/${dir}/ic_launcher.png`);
      expect(header).toMatchObject({ width: size, height: size });
    }
  });

  it("Android adaptive-icon foreground layers stayed transparent (alpha channel present)", () => {
    for (const appDir of ["app", "wear"]) {
      const header = pngHeader(
        `apps/android/${appDir}/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png`,
      );
      expect(header).toMatchObject({ width: 432, height: 432, colorType: 6 });
    }
  });
});
