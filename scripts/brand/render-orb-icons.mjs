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
const docsAssetsDir = path.join(repoRoot, "docs/assets");

/** Vasudev light paper and ink, per the brand guide. */
const PAPER_LIGHT = "#f7f7f9";
const INK_LIGHT = "#14151a";
const PAPER_DARK = "#0d0e12";
const INK_DARK = "#f2f3f6";
/** The display face for the wordmark, in the guide's preference order. Khand is
 * the standard; Space Grotesk is its documented fallback and the face this
 * checkout self-hosts today. Both are embedded as data URIs so the render never
 * reaches the network. */
const DISPLAY_FACE_CANDIDATES = [
  path.join(publicDir, "fonts/khand-600.woff2"),
  path.join(publicDir, "fonts/space-grotesk-latin.woff2"),
];

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

/** Docs hero and README banner: the orb with the wordmark on Vasudev paper.
 * The orb master is the frame's only gradient — the wordmark is set in ink — so
 * this script holds no copy of the gradient value at all.
 * Pixel sizes match the lobster artwork these replaced, so every existing
 * reference keeps its layout. */
const compositions = [
  {
    file: path.join(docsAssetsDir, "openclaw-hero-light.png"),
    width: 1192,
    height: 423,
    layout: "stack",
    theme: "light",
  },
  {
    file: path.join(docsAssetsDir, "openclaw-hero-dark.png"),
    width: 1192,
    height: 423,
    layout: "stack",
    theme: "dark",
  },
  {
    file: path.join(docsAssetsDir, "openclaw-banner-light.png"),
    width: 1280,
    height: 358,
    layout: "row",
    theme: "light",
  },
  {
    file: path.join(docsAssetsDir, "openclaw-banner-dark.png"),
    width: 1280,
    height: 358,
    layout: "row",
    theme: "dark",
  },
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

/** Inline the first available display face so the composition renders the
 * wordmark identically on every host, with no network fetch. */
function displayFaceRule() {
  const face = DISPLAY_FACE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!face) {
    throw new Error(
      `No display face found for the wordmark. Looked for ${DISPLAY_FACE_CANDIDATES.join(", ")}.`,
    );
  }
  const data = readFileSync(face).toString("base64");
  return `@font-face { font-family: "Vasudev Display"; font-weight: 600; font-display: block;
    src: url(data:font/woff2;base64,${data}) format("woff2"); }`;
}

function compositionDocument(svg, faceRule, { width, height, layout, theme }) {
  const dark = theme === "dark";
  const stacked = layout === "stack";
  const orbSize = stacked ? 132 : 104;
  const wordmarkSize = stacked ? 92 : 104;
  return `<!doctype html><meta charset="utf-8"><style>
    ${faceRule}
    html, body { margin: 0; width: ${width}px; height: ${height}px; }
    body { background: ${dark ? PAPER_DARK : PAPER_LIGHT}; }
    .frame {
      display: flex;
      ${stacked ? "flex-direction: column;" : "flex-direction: row;"}
      align-items: center;
      justify-content: center;
      gap: ${stacked ? 28 : 34}px;
      width: ${width}px;
      height: ${height}px;
    }
    svg { display: block; width: ${orbSize}px; height: ${orbSize}px; }
    .wordmark {
      font-family: "Vasudev Display", system-ui, sans-serif;
      font-weight: 600;
      font-size: ${wordmarkSize}px;
      line-height: 1;
      letter-spacing: -0.01em;
      white-space: nowrap;
    }
    .wordmark__ink { color: ${dark ? INK_DARK : INK_LIGHT}; }
  </style><div class="frame">${svg}<div class="wordmark"><span
    class="wordmark__ink">Vasu</span><span class="wordmark__ink">dev</span></div></div>`;
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

    const faceRule = displayFaceRule();
    for (const composition of compositions) {
      const page = await browser.newPage({
        viewport: { width: composition.width, height: composition.height },
        deviceScaleFactor: 1,
      });
      await page.setContent(compositionDocument(svg, faceRule, composition), {
        waitUntil: "load",
      });
      await page.evaluate(() => document.fonts.ready);
      writeFileSync(composition.file, await page.screenshot({ type: "png" }));
      await page.close();
      console.log(
        `rendered ${path.relative(repoRoot, composition.file)} (${composition.width}x${composition.height})`,
      );
    }
  } finally {
    await browser.close();
  }

  for (const copy of [path.join(publicDir, "favicon.svg"), path.join(docsAssetsDir, "orb.svg")]) {
    writeFileSync(copy, svg);
    console.log(`copied ${path.relative(repoRoot, copy)} from the orb master`);
  }

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
