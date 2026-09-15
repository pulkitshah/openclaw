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

async function orbMoodState(mood?: string): Promise<string | null> {
  const orb = document.createElement("vasu-orb") as Orb;
  if (mood !== undefined) {
    orb.setAttribute("mood", mood);
  }
  document.body.append(orb);
  await orb.updateComplete;
  return orb.shadowRoot?.querySelector(".vasu-orb")?.getAttribute("data-mood") ?? null;
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

  it("stops every mood's animation under reduced motion", () => {
    const styles = orbStyles().replace(/\s+/gu, " ");

    expect(styles).toContain(
      "@media (prefers-reduced-motion: reduce) { .vasu-orb, .vasu-orb[data-mood] { animation: none; } }",
    );
  });

  it("resolves each mood to one animation state on the orb body", async () => {
    expect(await orbMoodState()).toBe("idle");
    expect(await orbMoodState("idle")).toBe("idle");
    expect(await orbMoodState("curious")).toBe("idle");
    expect(await orbMoodState("thinking")).toBe("thinking");
    expect(await orbMoodState("working")).toBe("thinking");
    expect(await orbMoodState("error")).toBe("error");
    expect(await orbMoodState("needs-attention")).toBe("error");
    expect(await orbMoodState("sleeping")).toBe("sleeping");
    expect(await orbMoodState("sleepy")).toBe("sleeping");
    expect(await orbMoodState("off")).toBe("sleeping");
    expect(await orbMoodState("not-a-mood")).toBe("idle");
  });

  it("gives each mood its own motion: quicker breath, held glow, or none", () => {
    const styles = orbStyles().replace(/\s+/gu, " ");

    expect(styles).toContain('.vasu-orb[data-mood="thinking"] { animation: hue 8s ease infinite,');
    expect(styles).toContain("breathe 1.6s ease-in-out infinite");
    expect(styles).toContain(
      '.vasu-orb[data-mood="thinking"]::after { background: radial-gradient(',
    );
    expect(styles).toContain("rgba(255, 255, 255, 0.88)");
    expect(styles).toContain("box-shadow: 0 0 16px -2px var(--danger, #c9302c)");
    expect(styles).toContain('.vasu-orb[data-mood="error"]::before');
    expect(styles).toMatch(/\.vasu-orb\[data-mood="error"\] \{[^}]*animation: none;/u);
    expect(styles).toMatch(/\.vasu-orb\[data-mood="sleeping"\] \{[^}]*animation: none;/u);
    expect(styles).toContain("filter: saturate(0.12) brightness(0.92)");
  });

  it("keeps the mascot element alive as the orb under its old name", async () => {
    await import("./openclaw-mascot.ts");
    const mascot = document.createElement("openclaw-mascot") as Orb & { mood: string };
    mascot.mood = "thinking";
    document.body.append(mascot);
    await mascot.updateComplete;

    expect(mascot.mood).toBe("thinking");
    expect(mascot.shadowRoot?.querySelector(".vasu-orb")?.getAttribute("data-mood")).toBe(
      "thinking",
    );
    expect(mascot.style.getPropertyValue("--vasu-orb-size")).toBe("120px");
  });

  it("hides the decorative orb from assistive technology", async () => {
    expect((await mountOrb()).getAttribute("aria-hidden")).toBe("true");
  });
});
