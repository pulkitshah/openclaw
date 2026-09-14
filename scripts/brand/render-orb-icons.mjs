// Rasterize the Vasudev orb master into the Control UI icon set.
//
// `assets/brand/orb.svg` is the authoritative mark; every PNG here is derived
// from it, so edit the SVG and rerun this script rather than touching the PNGs.
// The repo ships no SVG rasterizer, so rendering goes through the Chromium that
// Playwright already installed for the browser test lanes — no download, no new
// dependency. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to point at another build.
//
// Usage: node scripts/brand/render-orb-icons.mjs
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { writeIcoFromPngs } from "./make-ico.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const masterPath = path.join(repoRoot, "assets/brand/orb.svg");
const publicDir = path.join(repoRoot, "ui/public");

/** Vasudev dark paper. iOS composites a transparent home-screen icon onto black,
 * so the touch icon gets the paper explicitly and the orb gets breathing room. */
const APP_ICON_PAPER = "#0d0e12";

const targets = [
  { file: path.join(publicDir, "favicon-32.png"), size: 32, inset: 0 },
  {
    file: path.join(publicDir, "apple-touch-icon.png"),
    size: 180,
    inset: 12,
    paper: APP_ICON_PAPER,
  },
  { file: path.join(repoRoot, "assets/brand/orb-512.png"), size: 512, inset: 0 },
  // ICO frames: rendered, packed, then dropped.
  { file: path.join(publicDir, "favicon-16.tmp.png"), size: 16, inset: 0, temporary: true },
  { file: path.join(publicDir, "favicon-48.tmp.png"), size: 48, inset: 0, temporary: true },
];

/** Playwright pins one Chromium revision per version; a checkout can carry a
 * neighbouring revision from an earlier install. Accept any installed Chromium
 * rather than downloading one. */
function resolveChromiumExecutable() {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH does not exist: ${override}`);
    }
    return override;
  }
  const pinned = chromium.executablePath();
  if (existsSync(pinned)) {
    return pinned;
  }
  const browsersRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH?.trim() ||
    (process.platform === "darwin"
      ? path.join(process.env.HOME ?? "", "Library/Caches/ms-playwright")
      : path.join(process.env.HOME ?? "", ".cache/ms-playwright"));
  // Everything below the per-revision directory is identical across revisions.
  const pinnedInstall = path.relative(browsersRoot, pinned).split(path.sep)[0];
  const relativeToInstall = path.relative(path.join(browsersRoot, pinnedInstall), pinned);
  const candidates = existsSync(browsersRoot)
    ? readdirSync(browsersRoot)
        .filter((entry) => /^chromium-\d+$/u.test(entry))
        .sort((left, right) => Number(right.slice(9)) - Number(left.slice(9)))
        .map((entry) => path.join(browsersRoot, entry, relativeToInstall))
    : [];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `No installed Chromium found. Looked for ${pinned} and under ${browsersRoot}. ` +
        "Run pnpm exec playwright install chromium, or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.",
    );
  }
  return found;
}

function iconDocument(svg, { size, inset, paper }) {
  const box = size - inset * 2;
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${size}px; height: ${size}px; background: ${paper ?? "transparent"}; }
    .frame { display: grid; place-items: center; width: ${size}px; height: ${size}px; }
    svg { display: block; width: ${box}px; height: ${box}px; }
  </style><div class="frame">${svg}</div>`;
}

async function main() {
  const svg = readFileSync(masterPath, "utf8");
  const executablePath = resolveChromiumExecutable();
  const browser = await chromium.launch({ executablePath });
  try {
    for (const target of targets) {
      const page = await browser.newPage({
        viewport: { width: target.size, height: target.size },
        deviceScaleFactor: 1,
      });
      await page.setContent(iconDocument(svg, target), { waitUntil: "load" });
      const png = await page.screenshot({ omitBackground: !target.paper, type: "png" });
      writeFileSync(target.file, png);
      await page.close();
      console.log(`rendered ${path.relative(repoRoot, target.file)} (${target.size}px)`);
    }
  } finally {
    await browser.close();
  }

  const faviconSvg = path.join(publicDir, "favicon.svg");
  writeFileSync(faviconSvg, svg);
  console.log(`copied ${path.relative(repoRoot, faviconSvg)} from the orb master`);

  const icoFrames = [
    path.join(publicDir, "favicon-16.tmp.png"),
    path.join(publicDir, "favicon-32.png"),
    path.join(publicDir, "favicon-48.tmp.png"),
  ];
  const ico = writeIcoFromPngs(path.join(publicDir, "favicon.ico"), icoFrames);
  console.log(`wrote ${path.relative(repoRoot, ico.outputPath)} (${ico.frames.join(", ")})`);

  for (const target of targets.filter((entry) => entry.temporary)) {
    rmSync(target.file, { force: true });
  }
}

await main();
