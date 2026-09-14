/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import "./vasu-wordmark.ts";

type Wordmark = HTMLElement & { updateComplete: Promise<unknown>; size: string };

async function mountWordmark(size?: string): Promise<Wordmark> {
  const wordmark = document.createElement("vasu-wordmark") as Wordmark;
  if (size !== undefined) {
    wordmark.setAttribute("size", size);
  }
  document.body.append(wordmark);
  await wordmark.updateComplete;
  return wordmark;
}

function wordmarkStyles(): string {
  const constructor = customElements.get("vasu-wordmark") as unknown as {
    styles: { cssText: string };
  };
  return constructor.styles.cssText;
}

describe("vasu-wordmark", () => {
  it("renders 'Vasu' in ink and 'dev' in the gradient as two spans", async () => {
    const wordmark = await mountWordmark();
    const spans = Array.from(wordmark.shadowRoot?.querySelectorAll("span") ?? []);

    expect(spans).toHaveLength(2);
    expect(spans[0]?.textContent).toBe("Vasu");
    expect(spans[1]?.textContent).toBe("dev");
    expect(spans[0]?.className).toBe("vasu-wordmark__ink");
    expect(spans[1]?.className).toBe("vasu-wordmark__gradient");
  });

  it("names the whole lockup for assistive technology", async () => {
    const wordmark = await mountWordmark();

    expect(wordmark.getAttribute("aria-label")).toBe("Vasudev");
    expect(wordmark.getAttribute("role")).toBe("img");
  });

  it("reflects the three lockup sizes and falls back to md", async () => {
    expect((await mountWordmark("sm")).getAttribute("size")).toBe("sm");
    expect((await mountWordmark("lg")).getAttribute("size")).toBe("lg");
    expect((await mountWordmark()).getAttribute("size")).toBe("md");
    expect((await mountWordmark("enormous")).getAttribute("size")).toBe("md");
  });

  it("styles every size and fills only 'dev' with the signature gradient", () => {
    const styles = wordmarkStyles();

    for (const size of ["sm", "md", "lg"]) {
      expect(styles).toContain(`:host([size="${size}"])`);
    }
    expect(styles).toContain("var(--font-display");
    expect(styles).toContain("font-weight: 600");
    expect(styles).toContain("linear-gradient(");
    expect(styles).toContain("background-clip: text");
    expect(styles).toContain("color: transparent");
  });
});
