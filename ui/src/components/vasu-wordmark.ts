import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";

/** Lockup sizes from the brand guide: sidebar row, card header, hero. */
const WORDMARK_SIZES = ["sm", "md", "lg"] as const;

export type VasuWordmarkSize = (typeof WORDMARK_SIZES)[number];

const DEFAULT_SIZE: VasuWordmarkSize = "md";

/** The Vasudev wordmark: "Vasu" in ink, "dev" filled with the signature
 * gradient, set in the display face at 600. It sits next to `<vasu-orb>` on the
 * login gate, the sidebar header and About. Text, not artwork: the host carries
 * `role="img"` with the full name so a heading or button around it still reads
 * "Vasudev" to assistive technology. */
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

    /* The gradient is spent here: "dev" is the only painted glyph run. */
    .vasu-wordmark__gradient {
      background-image: linear-gradient(
        95deg,
        #ffc24b 0%,
        #f97316 16%,
        #e0218a 38%,
        #8a2be2 58%,
        #3a6ff0 78%,
        #16c79a 100%
      );
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
  `;

  @property({ reflect: true }) size: VasuWordmarkSize = DEFAULT_SIZE;

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
    return html`<span class="vasu-wordmark__ink">Vasu</span
      ><span class="vasu-wordmark__gradient">dev</span>`;
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
