import { css, html, LitElement, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";
import { SIGNATURE_GRADIENT } from "../app/brand-gradient.ts";

/** Lockup sizes from the brand guide: sidebar row, card header, hero. */
const WORDMARK_SIZES = ["sm", "md", "lg"] as const;

export type VasuWordmarkSize = (typeof WORDMARK_SIZES)[number];

const DEFAULT_SIZE: VasuWordmarkSize = "md";

/** The Vasudev wordmark: "Vasu" in ink and "dev" filled with the signature
 * gradient, set in the display face at 600. It sits next to `<vasu-orb>` on the
 * login gate, the sidebar header and About.
 *
 * The gradient is spent once per screen. Set `beside-orb` wherever the orb is
 * already carrying it — every placement in the product today — and "dev" falls
 * back to ink; the gradient span is for an orb-less lockup, where the wordmark
 * is the screen's only mark.
 *
 * Text, not artwork: the host carries `role="img"` with the full name so a
 * heading or button around it still reads "Vasudev" to assistive technology. */
class VasuWordmark extends LitElement {
  static override styles = css`
    :host {
      display: inline-flex;
      align-items: baseline;
      font-family: var(--font-display, "Khand", "Space Grotesk", system-ui, sans-serif);
      font-weight: 600;
      font-size: 19px;
      line-height: 1;
      letter-spacing: -0.01em;
      white-space: nowrap;
      contain: layout style;
    }

    :host([size="sm"]) {
      font-size: 15px;
    }

    :host([size="md"]) {
      font-size: 19px;
    }

    :host([size="lg"]) {
      font-size: 26px;
    }

    .vasu-wordmark__ink {
      color: var(--text-strong, #14151a);
    }

    /* Orb-less lockups only: next to the orb this span is not rendered, so the
       screen keeps exactly one gradient. */
    .vasu-wordmark__gradient {
      background-image: var(--brand-gradient, ${unsafeCSS(SIGNATURE_GRADIENT)});
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
  `;

  @property({ reflect: true }) size: VasuWordmarkSize = DEFAULT_SIZE;

  /** The adjacent `<vasu-orb>` carries the gradient, so "dev" renders in ink. */
  @property({ type: Boolean, reflect: true, attribute: "beside-orb" }) besideOrb = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute("role", "img");
    this.setAttribute("aria-label", "Vasudev");
    this.normalizeSize();
  }

  protected override willUpdate(): void {
    this.normalizeSize();
  }

  override render() {
    const devClass = this.besideOrb ? "vasu-wordmark__ink" : "vasu-wordmark__gradient";
    return html`<span class="vasu-wordmark__ink">Vasu</span><span class=${devClass}>dev</span>`;
  }

  /** An unknown `size` attribute still has to render a usable lockup. */
  private normalizeSize(): void {
    if (!WORDMARK_SIZES.includes(this.size)) {
      this.size = DEFAULT_SIZE;
    }
  }
}

if (!customElements.get("vasu-wordmark")) {
  customElements.define("vasu-wordmark", VasuWordmark);
}
