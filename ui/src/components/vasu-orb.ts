import { css, html, LitElement, unsafeCSS, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { SIGNATURE_GRADIENT } from "../app/brand-gradient.ts";

/** Topbar lockup size from the brand guide; the hero mark passes a larger size. */
const DEFAULT_SIZE = 27;

/** What the mark is doing. The orb is also the product's status light — the
 * mascot element it replaced carried a live mood — so these four states own the
 * animation, and `data-mood` on the orb body selects it. */
export type VasuOrbMood = "idle" | "thinking" | "error" | "sleeping";

/** Every mood name callers pass, mapped onto the four states. The mascot
 * surfaces (channels, custodian, assistant panel) keep their own vocabulary, so
 * their values resolve here instead of at each call site. */
const ORB_MOODS = {
  idle: "idle",
  curious: "idle",
  attentive: "idle",
  happy: "idle",
  celebrating: "idle",
  thinking: "thinking",
  working: "thinking",
  error: "error",
  "needs-attention": "error",
  sad: "error",
  sleeping: "sleeping",
  sleepy: "sleeping",
  off: "sleeping",
} as const satisfies Record<string, VasuOrbMood>;

export type VasuOrbMoodInput = keyof typeof ORB_MOODS;

function resolveMood(mood: string): VasuOrbMood {
  return ORB_MOODS[mood as VasuOrbMoodInput] ?? "idle";
}

/** The Vasudev brand mark. The orb is CSS, not artwork: the signature gradient
 * drifts across an oversized background box, a radial highlight sits off-center,
 * and the tinted glow bleeds past the circle. `assets/brand/orb.svg` is the
 * static master used for favicons and app icons; keep the two in step. The
 * gradient itself comes from the `--brand-gradient` token, with
 * `ui/src/app/brand-gradient.ts` as the literal it falls back to. */
class VasuOrb extends LitElement {
  static override styles = css`
    :host {
      display: inline-block;
      width: var(--vasu-orb-size, 27px);
      height: var(--vasu-orb-size, 27px);
      line-height: 0;
      contain: layout style;
      pointer-events: none;
    }

    .vasu-orb {
      position: relative;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: var(--brand-gradient, ${unsafeCSS(SIGNATURE_GRADIENT)});
      background-size: 180% 180%;
      box-shadow: 0 0 14px -3px rgba(138, 43, 226, 0.75);
      filter: saturate(1.05);
      animation:
        hue 8s ease infinite,
        breathe 5s ease-in-out infinite;
    }

    .vasu-orb::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: radial-gradient(
        circle at 34% 30%,
        rgba(255, 255, 255, 0.62),
        rgba(255, 255, 255, 0) 55%
      );
    }

    /* Working: the same hue drift over a quicker breath, highlight turned up. */
    .vasu-orb[data-mood="thinking"] {
      animation:
        hue 8s ease infinite,
        breathe 1.6s ease-in-out infinite;
    }

    .vasu-orb[data-mood="thinking"]::after {
      background: radial-gradient(
        circle at 34% 30%,
        rgba(255, 255, 255, 0.88),
        rgba(255, 255, 255, 0) 62%
      );
    }

    /* Needs attention: a steady red glow that holds still, so a stuck run does
       not read as work in progress. */
    .vasu-orb[data-mood="error"] {
      background-position: 0% 50%;
      box-shadow: 0 0 16px -2px var(--danger, #c9302c);
      filter: saturate(0.5);
      animation: none;
    }

    .vasu-orb[data-mood="error"]::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: var(--danger, #c9302c);
      opacity: 0.5;
    }

    /* Asleep or switched off: the mark stays, the colour and motion leave. */
    .vasu-orb[data-mood="sleeping"] {
      background-position: 0% 50%;
      box-shadow: none;
      filter: saturate(0.12) brightness(0.92);
      animation: none;
    }

    @keyframes hue {
      0%,
      100% {
        background-position: 0% 50%;
      }

      50% {
        background-position: 100% 50%;
      }
    }

    @keyframes breathe {
      0%,
      100% {
        transform: scale(1);
      }

      50% {
        transform: scale(1.09);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .vasu-orb,
      .vasu-orb[data-mood] {
        animation: none;
      }
    }
  `;

  @property({ type: Number }) size = DEFAULT_SIZE;
  @property({ reflect: true }) mood: VasuOrbMoodInput = "idle";

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute("aria-hidden", "true");
    this.applySize();
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("size")) {
      this.applySize();
    }
  }

  override render() {
    return html`<div class="vasu-orb" data-mood=${resolveMood(this.mood)}></div>`;
  }

  private applySize(): void {
    const size = Number.isFinite(this.size) && this.size > 0 ? this.size : DEFAULT_SIZE;
    this.style.setProperty("--vasu-orb-size", `${size}px`);
  }
}

if (!customElements.get("vasu-orb")) {
  customElements.define("vasu-orb", VasuOrb);
}

export { VasuOrb };
