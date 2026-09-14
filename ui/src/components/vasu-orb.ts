import { css, html, LitElement, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";

/** Topbar lockup size from the brand guide; the hero mark passes a larger size. */
const DEFAULT_SIZE = 27;

/** The Vasudev brand mark. The orb is CSS, not artwork: the signature gradient
 * drifts across an oversized background box, a radial highlight sits off-center,
 * and the tinted glow bleeds past the circle. `assets/brand/orb.svg` is the
 * static master used for favicons and app icons; keep the two in step. */
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
      background: linear-gradient(
        95deg,
        #ffc24b 0%,
        #f97316 16%,
        #e0218a 38%,
        #8a2be2 58%,
        #3a6ff0 78%,
        #16c79a 100%
      );
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
      .vasu-orb {
        animation: none;
      }
    }
  `;

  @property({ type: Number }) size = DEFAULT_SIZE;

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
    return html`<div class="vasu-orb"></div>`;
  }

  private applySize(): void {
    const size = Number.isFinite(this.size) && this.size > 0 ? this.size : DEFAULT_SIZE;
    this.style.setProperty("--vasu-orb-size", `${size}px`);
  }
}

if (!customElements.get("vasu-orb")) {
  customElements.define("vasu-orb", VasuOrb);
}
