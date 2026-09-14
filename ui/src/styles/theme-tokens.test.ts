// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Vasudev brand guardrail for the default (claw) palette.
 *
 * The rebrand is a value-only swap: every component keeps reading the same
 * token names, so this file pins the palette, shape, motion and type values
 * from docs/superpowers/specs/2026-09-14-vasudev-theme-design.md §1 and
 * ~/.claude/commands/vasudev-brand.md, and freezes the token *names* base.css
 * declares. A drifted value or a renamed/dropped token fails here instead of
 * silently changing what several hundred call sites paint.
 *
 * The WCAG floors for these values stay in base-theme-contrast.node.test.ts;
 * this file only asserts identity.
 */

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");

/** base.css is dark-first: bare `:root` is the dark palette. */
const DARK_SELECTOR = ":root";
const LIGHT_SELECTOR = ':root:where([data-theme-mode="light"])';

function escapeSelector(selector: string): string {
  return selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** One line per declaration, so a wrapped value compares as it was written. */
function normalizeValue(value: string): string {
  return value.replaceAll(/\s+/gu, " ").replaceAll(/\(\s/gu, "(").replaceAll(/\s\)/gu, ")").trim();
}

/**
 * Read one palette block. base.css declares `:root` more than once (palette,
 * the coarse-pointer menu height, the corner-shape capability signal), so the
 * declarations are merged the way the cascade merges them.
 */
function readBlockTokens(selector: string): Map<string, string> {
  const pattern = new RegExp(`${escapeSelector(selector)}\\s*\\{([^}]*)\\}`, "gu");
  const tokens = new Map<string, string>();
  for (const block of baseCss.matchAll(pattern)) {
    const body = (block[1] ?? "").replaceAll(/\/\*[\s\S]*?\*\//gu, "");
    for (const statement of body.split(";")) {
      const declaration = statement.match(/^\s*(--[\w-]+)\s*:([\s\S]+)$/u);
      if (declaration?.[1] && declaration[2]) {
        tokens.set(declaration[1], normalizeValue(declaration[2]));
      }
    }
  }
  return tokens;
}

function expectTokens(selector: string, expected: readonly (readonly [string, string])[]): void {
  const tokens = readBlockTokens(selector);
  const actual = expected.map(([name]) => [name, tokens.get(name)] as const);
  expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected));
}

/*
 * Light palette. Paper/surface/surface-2/sunken, the three inks, the two line
 * steps, the violet tint with its soft tone and focus ring, and the four status
 * pairs. `--border-strong` is the one derived neutral: the guide's line-2
 * #dfdfe6 sits 1.24:1 from paper, under the markdown code chip's 1.25:1 floor,
 * so it is nudged three levels darker.
 */
const LIGHT_TOKENS = [
  ["--bg", "#f7f7f9"],
  ["--bg-accent", "#f2f2f5"],
  ["--bg-content", "#f2f2f5"],
  ["--bg-elevated", "#ffffff"],
  ["--bg-hover", "#eaeaef"],
  ["--bg-muted", "#eaeaef"],
  ["--card", "#ffffff"],
  ["--panel", "#fafafb"],
  ["--panel-strong", "#f2f2f5"],
  ["--panel-hover", "#eaeaef"],
  ["--text", "#14151a"],
  ["--text-strong", "#14151a"],
  ["--chat-text", "#14151a"],
  ["--card-foreground", "#14151a"],
  ["--muted", "#585c66"],
  ["--muted-strong", "#585c66"],
  ["--muted-foreground", "#585c66"],
  ["--file-icon-glyph", "#9498a2"],
  ["--border", "#eaeaef"],
  ["--border-strong", "#d9d9e2"],
  ["--border-hover", "#9498a2"],
  ["--input", "#eaeaef"],
  ["--accent", "#8a2be2"],
  ["--accent-subtle", "#f3ebfd"],
  ["--ring", "#8a2be2"],
  ["--focus", "rgba(93, 51, 229, 0.4)"],
  ["--ok", "#12a150"],
  ["--ok-subtle", "#e9f7ee"],
  ["--warn", "#b9820f"],
  ["--warn-subtle", "#faf1dc"],
  ["--info", "#3a6ff0"],
  ["--info-subtle", "#ecf1fe"],
  ["--danger", "#c9302c"],
  ["--danger-subtle", "#fbe9e8"],
  ["--shadow-sm", "0 1px 2px rgba(20, 21, 26, 0.05)"],
  ["--shadow-lg", "0 1px 2px rgba(20, 21, 26, 0.05), 0 18px 50px -14px rgba(20, 21, 26, 0.12)"],
] as const;

/*
 * Dark palette. The guide gives dark paper/surface/ink/line, the lifted tint
 * and the four soft status tones; the status base hues carry over from light in
 * their existing dark-lifted form, which is what keeps their AA margin.
 */
const DARK_TOKENS = [
  ["--bg", "#0d0e12"],
  ["--bg-accent", "#131418"],
  ["--bg-elevated", "#1d1f26"],
  ["--bg-hover", "#1d1f26"],
  ["--bg-muted", "#1d1f26"],
  ["--card", "#16171c"],
  ["--panel", "#0d0e12"],
  ["--panel-strong", "#1d1f26"],
  ["--panel-hover", "#242730"],
  ["--text", "#f2f3f6"],
  ["--text-strong", "#f2f3f6"],
  ["--chat-text", "#f2f3f6"],
  ["--card-foreground", "#f2f3f6"],
  ["--muted", "#a6aab4"],
  ["--muted-strong", "#a6aab4"],
  ["--muted-foreground", "#a6aab4"],
  ["--file-icon-glyph", "#6b6f7a"],
  ["--border", "#242730"],
  ["--border-strong", "#31353f"],
  ["--border-hover", "#6b6f7a"],
  ["--input", "#242730"],
  ["--accent", "#a58bf0"],
  ["--ring", "#a58bf0"],
  ["--ok-subtle", "#122619"],
  ["--warn-subtle", "#2a2210"],
  ["--info-subtle", "#111e37"],
  ["--danger-subtle", "#2d1514"],
] as const;

/*
 * Shape, motion, type and the signature gradient. The guide's 18px card radius
 * lands on --radius-lg (the card/panel step); the gradient is declared once,
 * beside the other theme-invariant brand colors, and only the orb and the
 * wordmark's "dev" may spend it.
 */
const INVARIANT_TOKENS = [
  ["--radius-lg", "18px"],
  ["--ease-out", "cubic-bezier(0.22, 0.68, 0.28, 1)"],
  ["--font-display", '"Khand", "Space Grotesk", system-ui, sans-serif'],
  [
    "--mono",
    '"Space Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace',
  ],
  [
    "--brand-gradient",
    "linear-gradient(95deg, #ffc24b 0%, #f97316 16%, #e0218a 38%, #8a2be2 58%, #3a6ff0 78%, #16c79a 100%)",
  ],
] as const;

/*
 * Every token name base.css declared before the Vasudev swap (git show
 * HEAD~:ui/src/styles/base.css at the rebrand commit). The rebrand changed
 * values only, so components needed no edits; --brand-gradient is the single
 * addition, because the signature gradient had been duplicated inside
 * vasu-orb.ts with no token to share. Adding or removing a name here is a
 * deliberate design-system change, not a palette edit.
 */
const TOKEN_NAMES_BEFORE_REBRAND = [
  "--accent",
  "--accent-2",
  "--accent-2-muted",
  "--accent-2-subtle",
  "--accent-foreground",
  "--accent-glow",
  "--accent-hover",
  "--accent-muted",
  "--accent-subtle",
  "--bg",
  "--bg-accent",
  "--bg-content",
  "--bg-elevated",
  "--bg-hover",
  "--bg-muted",
  "--border",
  "--border-hover",
  "--border-strong",
  "--brand-claude",
  "--brand-codex",
  "--brand-google",
  "--brand-logo-chip-bg",
  "--button-icon-bg",
  "--card",
  "--card-foreground",
  "--card-highlight",
  "--chat-block-gap",
  "--chat-text",
  "--chat-text-size",
  "--chrome",
  "--chrome-strong",
  "--control-ui-environment-amber",
  "--control-ui-environment-amber-ink",
  "--control-ui-environment-blue",
  "--control-ui-environment-blue-ink",
  "--control-ui-environment-coral",
  "--control-ui-environment-coral-ink",
  "--control-ui-environment-gray",
  "--control-ui-environment-gray-ink",
  "--control-ui-environment-green",
  "--control-ui-environment-green-ink",
  "--control-ui-environment-pink",
  "--control-ui-environment-pink-ink",
  "--control-ui-environment-purple",
  "--control-ui-environment-purple-ink",
  "--control-ui-environment-red",
  "--control-ui-environment-red-ink",
  "--control-ui-environment-teal",
  "--control-ui-environment-teal-ink",
  "--control-ui-input-text-size",
  "--control-ui-text-lg",
  "--control-ui-text-md",
  "--control-ui-text-scale",
  "--control-ui-text-sm",
  "--control-ui-text-xs",
  "--cursor-action",
  "--danger",
  "--danger-muted",
  "--danger-solid-hover",
  "--danger-subtle",
  "--destructive",
  "--destructive-foreground",
  "--destructive-hover",
  "--duration-fast",
  "--duration-normal",
  "--duration-slow",
  "--ease-in-out",
  "--ease-out",
  "--ease-spring",
  "--exec-highlight",
  "--file-icon-glyph",
  "--focus",
  "--focus-glow",
  "--focus-ring",
  "--font-body",
  "--font-chat",
  "--font-display",
  "--font-shortcut",
  "--grid-line",
  "--hide-duration",
  "--hljs-addition",
  "--hljs-attribute",
  "--hljs-deletion",
  "--hljs-keyword",
  "--hljs-meta",
  "--hljs-number",
  "--hljs-string",
  "--hljs-title",
  "--hljs-type",
  "--inbox-attention",
  "--inbox-attention-foreground",
  "--inbox-attention-hover",
  "--info",
  "--info-subtle",
  "--input",
  "--link",
  "--link-hover",
  "--lobster-icon-body",
  "--lobster-icon-eye",
  "--lobster-icon-shade",
  "--media-bg",
  "--media-foreground",
  "--menu-item-height",
  "--menu-item-radius",
  "--menu-padding",
  "--menu-radius",
  "--menu-selected",
  "--mono",
  "--moon-base",
  "--moon-highlight",
  "--muted",
  "--muted-foreground",
  "--muted-strong",
  "--ok",
  "--ok-muted",
  "--ok-subtle",
  "--openclaw-corner-radius-scale",
  "--overlay-border",
  "--overlay-shadow",
  "--panel",
  "--panel-hover",
  "--panel-strong",
  "--popover",
  "--popover-foreground",
  "--pr-merged",
  "--primary",
  "--primary-foreground",
  "--primary-hover",
  "--qr-bg",
  "--qr-text",
  "--radius",
  "--radius-full",
  "--radius-lg",
  "--radius-md",
  "--radius-sm",
  "--radius-xl",
  "--rail-divider-color",
  "--rail-divider-size",
  "--rail-header-action-active-color",
  "--rail-header-action-color",
  "--rail-header-action-disabled-opacity",
  "--rail-header-action-gap",
  "--rail-header-action-glyph-size",
  "--rail-header-action-hover-color",
  "--rail-header-action-size",
  "--rail-header-background",
  "--rail-header-copy-gap",
  "--rail-header-eyebrow-letter-spacing",
  "--rail-header-eyebrow-size",
  "--rail-header-height",
  "--rail-header-padding-end",
  "--rail-header-padding-start",
  "--rail-header-title-size",
  "--rail-header-title-weight",
  "--resize-handle-active-color",
  "--resize-handle-active-line-size",
  "--resize-handle-line-size",
  "--resize-handle-rest-color",
  "--resize-handle-size",
  "--ring",
  "--safe-area-bottom",
  "--safe-area-left",
  "--safe-area-right",
  "--safe-area-top",
  "--scrollbar-size",
  "--scrollbar-thumb",
  "--scrollbar-thumb-hover",
  "--scrollbar-thumb-inset",
  "--secondary",
  "--secondary-foreground",
  "--select-chevron",
  "--selection-bg",
  "--selection-fg",
  "--session-color-blue",
  "--session-color-cyan",
  "--session-color-green",
  "--session-color-orange",
  "--session-color-pink",
  "--session-color-purple",
  "--session-color-red",
  "--session-color-yellow",
  "--session-hovercard-progress-surface",
  "--session-hovercard-surface",
  "--shadow-glow",
  "--shadow-lg",
  "--shadow-md",
  "--shadow-sm",
  "--shadow-xl",
  "--show-duration",
  "--space-1",
  "--space-2",
  "--space-3",
  "--space-4",
  "--space-5",
  "--space-6",
  "--space-7",
  "--space-8",
  "--text",
  "--text-strong",
  "--theme-switch-x",
  "--theme-switch-y",
  "--wa-color-focus",
  "--wa-color-neutral-fill-normal",
  "--wa-form-control-activated-color",
  "--warn",
  "--warn-bright",
  "--warn-muted",
  "--warn-strong",
  "--warn-subtle",
  "--widget-frame-inset",
  "--z-dropdown",
  "--z-toast",
] as const;

const TOKEN_NAMES_ADDED_BY_REBRAND = ["--brand-gradient"] as const;

describe("Vasudev theme tokens", () => {
  it("paints the light palette from the brand guide", () => {
    expectTokens(LIGHT_SELECTOR, LIGHT_TOKENS);
  });

  it("paints the dark palette from the brand guide", () => {
    expectTokens(DARK_SELECTOR, DARK_TOKENS);
  });

  it("carries the brand shape, motion, type and gradient", () => {
    expectTokens(DARK_SELECTOR, INVARIANT_TOKENS);
  });

  it("keeps the corner-shape refinement on the card radius", () => {
    // The @supports block sets border-radius directly (see base.css), so the
    // card radius appears there as a literal and has to track --radius-lg.
    expect(baseCss).toContain("border-radius: calc(18px * var(--openclaw-corner-radius-scale));");
    expect(baseCss).not.toContain("calc(14px * var(--openclaw-corner-radius-scale))");
  });

  it("changes token values without changing token names", () => {
    const declared = new Set<string>();
    for (const match of baseCss.matchAll(/^\s*(--[\w-]+)\s*:/gmu)) {
      declared.add(match[1] ?? "");
    }
    expect([...declared].toSorted()).toEqual(
      [...TOKEN_NAMES_BEFORE_REBRAND, ...TOKEN_NAMES_ADDED_BY_REBRAND].toSorted(),
    );
  });
});
