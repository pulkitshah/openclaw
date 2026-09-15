/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import "./vasu-wordmark.ts";

type Wordmark = HTMLElement & { updateComplete: Promise<unknown>; size: string };

async function mountWordmark(attributes: Record<string, string> = {}): Promise<Wordmark> {
  const wordmark = document.createElement("vasu-wordmark") as Wordmark;
  for (const [name, value] of Object.entries(attributes)) {
    wordmark.setAttribute(name, value);
  }
  document.body.append(wordmark);
  await wordmark.updateComplete;
  return wordmark;
}

function wordmarkSpans(wordmark: Wordmark): HTMLSpanElement[] {
  return Array.from(wordmark.shadowRoot?.querySelectorAll("span") ?? []);
}

function wordmarkStyles(): string {
  const constructor = customElements.get("vasu-wordmark") as unknown as {
    styles: { cssText: string };
  };
  return constructor.styles.cssText;
}

describe("vasu-wordmark", () => {
  it("renders 'Vasu' in ink and 'dev' in the gradient as two spans", async () => {
    const spans = wordmarkSpans(await mountWordmark());

    expect(spans).toHaveLength(2);
    expect(spans[0]?.textContent).toBe("Vasu");
    expect(spans[1]?.textContent).toBe("dev");
    expect(spans[0]?.className).toBe("vasu-wordmark__ink");
    expect(spans[1]?.className).toBe("vasu-wordmark__gradient");
  });

  it("drops 'dev' to ink beside the orb so one screen paints one gradient", async () => {
    const spans = wordmarkSpans(await mountWordmark({ "beside-orb": "" }));

    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.textContent)).toEqual(["Vasu", "dev"]);
    expect(spans.every((span) => span.className === "vasu-wordmark__ink")).toBe(true);
  });

  it("names the whole lockup for assistive technology", async () => {
    const wordmark = await mountWordmark();

    expect(wordmark.getAttribute("aria-label")).toBe("Vasudev");
    expect(wordmark.getAttribute("role")).toBe("img");
  });

  it("reflects the three lockup sizes and falls back to md", async () => {
    expect((await mountWordmark({ size: "sm" })).getAttribute("size")).toBe("sm");
    expect((await mountWordmark({ size: "lg" })).getAttribute("size")).toBe("lg");
    expect((await mountWordmark()).getAttribute("size")).toBe("md");
    expect((await mountWordmark({ size: "enormous" })).getAttribute("size")).toBe("md");
  });

  it("styles every size and fills only 'dev' from the shared gradient token", () => {
    const styles = wordmarkStyles();

    for (const size of ["sm", "md", "lg"]) {
      expect(styles).toContain(`:host([size="${size}"])`);
    }
    expect(styles).toContain("var(--font-display");
    expect(styles).toContain("font-weight: 600");
    expect(styles).toContain("background-image: var(--brand-gradient, linear-gradient(");
    expect(styles).toContain("background-clip: text");
    expect(styles).toContain("color: transparent");
  });
});
