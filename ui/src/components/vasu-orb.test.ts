/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import "./vasu-orb.ts";

type Orb = HTMLElement & { updateComplete: Promise<unknown>; size: number };

async function mountOrb(size?: string): Promise<Orb> {
  const orb = document.createElement("vasu-orb") as Orb;
  if (size !== undefined) {
    orb.setAttribute("size", size);
  }
  document.body.append(orb);
  await orb.updateComplete;
  return orb;
}

function orbStyles(): string {
  const constructor = customElements.get("vasu-orb") as unknown as { styles: { cssText: string } };
  return constructor.styles.cssText;
}

describe("vasu-orb", () => {
  it("renders the orb body and sizes the host from the size attribute", async () => {
    const orb = await mountOrb("27");

    expect(orb.shadowRoot?.querySelector(".vasu-orb")).not.toBeNull();
    expect(orb.style.getPropertyValue("--vasu-orb-size")).toBe("27px");
  });

  it("keeps a usable size for a missing or nonsense size attribute", async () => {
    expect((await mountOrb()).style.getPropertyValue("--vasu-orb-size")).toBe("27px");
    expect((await mountOrb("0")).style.getPropertyValue("--vasu-orb-size")).toBe("27px");
    expect((await mountOrb("not-a-number")).style.getPropertyValue("--vasu-orb-size")).toBe("27px");
    expect((await mountOrb("54")).style.getPropertyValue("--vasu-orb-size")).toBe("54px");
  });

  it("carries the brand orb presentation: gradient, highlight, glow, and motion", () => {
    const styles = orbStyles();

    expect(styles).toContain("background-size: 180% 180%");
    expect(styles).toContain("circle at 34% 30%");
    expect(styles).toContain("0 0 14px -3px");
    expect(styles).toContain("saturate(1.05)");
    expect(styles).toContain("hue 8s ease infinite");
    expect(styles).toContain("breathe 5s");
    expect(styles).toContain("scale(1.09)");
  });

  it("stops both animations under reduced motion", () => {
    const styles = orbStyles().replace(/\s+/gu, " ");

    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.vasu-orb \{ animation/u);
  });

  it("hides the decorative orb from assistive technology", async () => {
    expect((await mountOrb()).getAttribute("aria-hidden")).toBe("true");
  });
});
