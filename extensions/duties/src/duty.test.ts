import { describe, expect, it } from "vitest";
import { resolvePlaceholders, validateDuty } from "./duty.js";

const base = {
  id: "book-flight",
  name: "Book flight",
  summary: "Books a flight",
  status: "building",
  machine: "gateway",
  reportsTo: "owner",
  inputs: [],
  triggers: [{ kind: "manual" }],
  updatedAt: 1,
  steps: [
    {
      id: "s1",
      kind: "browser",
      label: "Open Amigos",
      params: { action: "open", url: "https://amigosalliance.co.in" },
    },
    {
      kind: "when",
      label: "If signed out, sign in",
      cond: { visible: { role: "textbox", name: "User Name" } },
      then: [
        {
          id: "s2",
          kind: "browser",
          label: "Fill username",
          params: { action: "fill", value: "{{cred:amigos.username}}" },
          target: { css: "#UserId" },
        },
      ],
    },
    { kind: "stop", label: "Nothing to book", reason: "Mail was not a booking request" },
  ],
};

describe("validateDuty", () => {
  it("accepts a well-formed duty", () => {
    const result = validateDuty(base);
    expect(result.ok).toBe(true);
  });
  it("rejects a step whose label is a selector, an unknown kind, and a draft status", () => {
    const bad = {
      ...base,
      status: "draft",
      steps: [{ id: "x", kind: "magic", label: "#btnlogin", params: {} }],
    };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("status"),
          expect.stringContaining("kind"),
          expect.stringContaining("label"),
        ]),
      );
    }
  });
  it("rejects duplicate step ids", () => {
    const dup = { ...base, steps: [base.steps[0], base.steps[0]] };
    expect(validateDuty(dup).ok).toBe(false);
  });
  it("rejects when with invalid cond (empty visible target)", () => {
    const bad = {
      ...base,
      steps: [{ kind: "when", label: "Bad cond", cond: { visible: {} }, then: [] }],
    };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("visible")]));
    }
  });
  it("rejects step with invalid check (empty attribute target)", () => {
    const bad = {
      ...base,
      steps: [
        {
          id: "x",
          kind: "browser",
          label: "Bad check",
          params: {},
          check: { attribute: { target: {}, name: "x" } },
        },
      ],
    };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("attribute")]));
    }
  });
  it("rejects invalid input source", () => {
    const bad = { ...base, inputs: [{ name: "x", source: "cron" }] };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("source")]));
    }
  });
  it("accepts unique nested when ids and rejects duplicate ids across branches", () => {
    const nested = {
      ...base,
      steps: [
        {
          kind: "when",
          label: "Outer when",
          cond: { visible: { css: ".outer" } },
          then: [{ id: "s1", kind: "browser", label: "In then", params: {} }],
          else: [{ id: "s2", kind: "browser", label: "In else", params: {} }],
        },
      ],
    };
    const result = validateDuty(nested);
    expect(result.ok).toBe(true);

    const dupBranch = {
      ...base,
      steps: [
        {
          kind: "when",
          label: "Outer when",
          cond: { visible: { css: ".outer" } },
          then: [{ id: "dup", kind: "browser", label: "In then", params: {} }],
          else: [{ id: "dup", kind: "browser", label: "In else", params: {} }],
        },
      ],
    };
    const result2 = validateDuty(dupBranch);
    expect(result2.ok).toBe(false);
  });
});

describe("resolvePlaceholders", () => {
  it("fills out/in and resolves cred through the getter", async () => {
    const out = await resolvePlaceholders("{{in:city}} → {{out:code}} / {{cred:k}}", {
      out: { code: "COK" },
      in: { city: "Kochi" },
      cred: async (key) => `secret-${key}`,
    });
    expect(out).toBe("Kochi → COK / secret-k");
  });
  it("throws for an unknown credential so placeholder text never reaches a form", async () => {
    await expect(
      resolvePlaceholders("{{cred:missing}}", {
        out: {},
        in: {},
        cred: async () => {
          throw new Error("no credential stored for missing");
        },
      }),
    ).rejects.toThrow("no credential stored for missing");
  });
  it("preserves dollar signs and regex metacharacters in credential values", async () => {
    const out = await resolvePlaceholders("password: {{cred:k}}", {
      out: {},
      in: {},
      cred: async () => "p$$w0rd$&",
    });
    expect(out).toBe("password: p$$w0rd$&");
  });
});
