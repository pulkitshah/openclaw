import { describe, expect, it } from "vitest";
import {
  parseTeamRouteTarget,
  resolvePlaceholders,
  validateDuty,
  validateRunInputs,
  type Duty,
} from "./duty.js";

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
      params: { action: "open", url: "https://portal.example.com" },
    },
    {
      kind: "when",
      label: "If signed out, sign in",
      cond: { visible: { role: "textbox", name: "User Name" } },
      // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
      then: [
        {
          id: "s2",
          kind: "browser",
          label: "Fill username",
          params: { action: "fill", value: "{{cred:acme-demo.username}}" },
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
  it("rejects a step id that is not a slug, so a rendered document cannot escape the run directory", () => {
    // The runner names a `template` step's document `<step.id>.pdf` and joins it onto the run's
    // own files directory; anything but a slug could place that file anywhere on disk and still be
    // served back by `duties.run.file`.
    for (const id of [
      "../../../../tmp/evil",
      "a/b",
      "a\\b",
      "..",
      "Caps",
      "-lead",
      "_lead",
      "x".repeat(65),
    ]) {
      const bad = { ...base, steps: [{ ...base.steps[0], id }] };
      const result = validateDuty(bad);
      expect(result.ok, id).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.stringContaining("step id must be a slug (letters, digits, _ -)"),
          ]),
        );
      }
    }
    for (const id of ["s1", "print-note", "print_note", "0", "x".repeat(64)]) {
      const good = { ...base, steps: [{ ...base.steps[0], id }] };
      expect(validateDuty(good).ok, id).toBe(true);
    }
  });
  it("rejects when with invalid cond (empty visible target)", () => {
    const bad = {
      ...base,
      // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
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
  it("rejects a check that only Part 2 will support", () => {
    const bad = {
      ...base,
      steps: [
        {
          id: "x",
          kind: "browser",
          label: "Bad check",
          params: {},
          check: { attribute: { target: { css: "#x" }, name: "value" } },
        },
      ],
    };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("attribute checks arrive in Part 2")]),
      );
    }
  });
  it("rejects an unknown check key instead of treating it as an empty check", () => {
    const bad = {
      ...base,
      steps: [
        { id: "x", kind: "browser", label: "Typo check", params: {}, check: { url_match: "/x" } },
      ],
    };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("unknown check key")]),
      );
    }
  });
  it("rejects an unknown target key instead of silently ignoring it", () => {
    const bad = {
      ...base,
      steps: [
        {
          id: "x",
          kind: "browser",
          label: "Typo target",
          params: {},
          target: { role: "button", nome: "Sign in" },
        },
      ],
    };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("unknown target key")]),
      );
    }
  });
  it("accepts a when whose cond matches the url and rejects an unknown cond kind", () => {
    const good = {
      ...base,
      steps: [
        {
          kind: "when",
          label: "Already on the dashboard",
          cond: { url_matches: "/Home/Dashboard" },
          // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
          then: [],
        },
      ],
    };
    expect(validateDuty(good).ok).toBe(true);

    const bad = {
      ...base,
      // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
      steps: [{ kind: "when", label: "Typo cond", cond: { url_match: "/x" }, then: [] }],
    };
    const result = validateDuty(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("unknown condition kind")]),
      );
    }
  });
  it("requires at least one trigger so an active Duty is always runnable", () => {
    const result = validateDuty({ ...base, triggers: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([expect.stringContaining("at least one trigger")]),
      );
    }
  });
  it("accepts a cred placeholder in a fill value but rejects it anywhere else", () => {
    expect(validateDuty(base).ok).toBe(true);

    const inSelect = {
      ...base,
      steps: [
        {
          id: "s1",
          kind: "browser",
          label: "Pick the account",
          params: { action: "select", value: "{{cred:acme-demo.account}}" },
          target: { css: "#acct" },
        },
      ],
    };
    expect(validateDuty(inSelect).ok).toBe(true);

    const cases: Array<{ what: string; steps: unknown[] }> = [
      {
        what: "an ai instruction",
        steps: [
          {
            id: "s1",
            kind: "ai",
            label: "Read the mail",
            params: { instruction: "sign in with {{cred:acme-demo.password}}", input: "x" },
          },
        ],
      },
      {
        what: "a nested ai input",
        steps: [
          {
            id: "s1",
            kind: "ai",
            label: "Read the mail",
            params: { instruction: "read", input: { token: "{{cred:acme-demo.token}}" } },
          },
        ],
      },
      {
        what: "a template filename",
        steps: [
          {
            id: "s1",
            kind: "template",
            label: "Render the quote",
            params: {
              template: "quote",
              filename: "quote-{{cred:acme-demo.username}}",
              fill: {},
            },
          },
        ],
      },
      {
        what: "an ask question",
        steps: [
          {
            id: "s1",
            kind: "ask",
            label: "Confirm",
            params: { question: "Use {{cred:acme-demo.token}}?" },
          },
        ],
      },
      {
        what: "a navigate url",
        steps: [
          {
            id: "s1",
            kind: "browser",
            label: "Open the reset link",
            params: { action: "navigate", url: "https://x/?t={{cred:acme-demo.token}}" },
          },
        ],
      },
      {
        what: "a press key",
        steps: [
          {
            id: "s1",
            kind: "browser",
            label: "Press the key",
            params: { action: "press", key: "{{cred:acme-demo.token}}" },
          },
        ],
      },
      {
        what: "an evaluate body",
        steps: [
          {
            id: "s1",
            kind: "browser.evaluate",
            label: "Read the token",
            params: { fn: "() => '{{cred:acme-demo.token}}'" },
          },
        ],
      },
      {
        what: "a stop reason",
        steps: [{ kind: "stop", label: "Done", reason: "used {{cred:acme-demo.token}}" }],
      },
      {
        what: "a when cond",
        steps: [
          {
            kind: "when",
            label: "Token already set",
            cond: { text_matches: "{{cred:acme-demo.token}}" },
            // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
            then: [],
          },
        ],
      },
    ];
    for (const { what, steps } of cases) {
      const result = validateDuty({ ...base, steps });
      expect(result.ok, what).toBe(false);
      if (!result.ok) {
        expect(result.errors.join("; "), what).toContain("only allowed in a browser fill/select");
      }
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
          // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
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
          // oxlint-disable-next-line unicorn/no-thenable -- the Duty when/then/else branch, not a Promise thenable.
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
  // Regression: a dotted path walked the prototype chain, so `{{out:constructor}}` resolved to a
  // function and the substitution wrote the literal text "undefined" into the document.
  it("reads own properties only, so a prototype key resolves to empty rather than to `undefined`", async () => {
    const out = await resolvePlaceholders("[{{out:constructor}}][{{in:__proto__}}][{{out:a.b}}]", {
      out: { a: {} },
      in: {},
    });
    expect(out).toBe("[][][]");
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

describe("Part 2 model", () => {
  const baseDuty = () => ({
    id: "t",
    name: "T",
    summary: "",
    status: "active",
    machine: "gateway",
    reportsTo: "owner",
    inputs: [],
    steps: [],
    triggers: [{ kind: "manual" }],
    updatedAt: 1,
  });

  it("accepts mail and chat triggers with a match and rejects them without one", () => {
    const ok = validateDuty({
      ...baseDuty(),
      triggers: [
        { kind: "mail", match: "travel requests" },
        { kind: "chat", match: "a forwarded request" },
      ],
    });
    expect(ok.ok).toBe(true);
    const bad = validateDuty({ ...baseDuty(), triggers: [{ kind: "mail" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join(",")).toMatch(/triggers\[0\]\.match/u);
    }
  });

  it("validates template and deliver step params", () => {
    const good = validateDuty({
      ...baseDuty(),
      steps: [
        {
          id: "t1",
          kind: "template",
          label: "Render options",
          params: {
            template: "flight-options",
            fill: { route: { from: "{{out:route}}" }, notes: { ai: "Summarize" } },
          },
        },
        {
          id: "d1",
          kind: "deliver",
          label: "Send it",
          params: { to: "trigger", text: "Here you go", files: ["{{file:t1}}"] },
        },
      ],
    });
    expect(good.ok).toBe(true);
    const bad = validateDuty({
      ...baseDuty(),
      steps: [
        { id: "t1", kind: "template", label: "Render", params: { fill: { x: { nope: 1 } } } },
        { id: "d1", kind: "deliver", label: "Send", params: { to: "someone" } },
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join("\n")).toMatch(/params\.template: must be a non-empty string/u);
      expect(bad.errors.join("\n")).toMatch(/params\.fill\.x: must be \{ from \} or \{ ai \}/u);
      expect(bad.errors.join("\n")).toMatch(
        /params\.channel: required when to is not "trigger" or "owner"/u,
      );
    }
  });

  // Regression (I4): the error text promised the `{{file:<stepId>}}` shape but the check only
  // required `string`, so `files: ["/Users/…/.openclaw/openclaw.json"]` was a valid Duty that
  // mailed a state file to any channel target. Authoring is done by an agent that reads untrusted
  // mail and web content, so this is a real injection sink.
  it("rejects a deliver files entry that is not a {{file:<stepId>}} placeholder", () => {
    const rawPath = validateDuty({
      ...baseDuty(),
      steps: [
        {
          id: "d1",
          kind: "deliver",
          label: "Send",
          params: { to: "owner", files: ["/Users/someone/.openclaw/openclaw.json"] },
        },
      ],
    });
    expect(rawPath.ok).toBe(false);
    if (!rawPath.ok) {
      expect(rawPath.errors.join("\n")).toMatch(
        /params\.files\[0\]: must be a \{\{file:<stepId>\}\} placeholder/u,
      );
    }
    // A placeholder with anything around it is not a placeholder either.
    expect(
      validateDuty({
        ...baseDuty(),
        steps: [
          {
            id: "d1",
            kind: "deliver",
            label: "Send",
            params: { to: "owner", files: ["see {{file:t1}}"] },
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateDuty({
        ...baseDuty(),
        steps: [
          {
            id: "d1",
            kind: "deliver",
            label: "Send",
            params: { to: "owner", files: ["{{file:t1}}"] },
          },
        ],
      }).ok,
    ).toBe(true);
  });

  // Regression (I1): `questionCard` silently returned plain text when the options were not 2–4
  // distinct values, and a typed reply does not resolve a plugin-raised question — so a real
  // booking approval reached the owner as un-tappable prose and their "Yes" went to the agent as
  // ordinary chat. The rule is enforced where the author can act on it: at save time.
  it("rejects an ask whose options cannot make a tappable card", () => {
    const ask = (params: Record<string, unknown>) =>
      validateDuty({
        ...baseDuty(),
        steps: [{ id: "a1", kind: "ask", label: "Approve?", params }],
      });

    expect(ask({ question: "Hold this booking?", options: ["Approve", "Decline"] }).ok).toBe(true);

    for (const options of [["Approve"], ["a", "b", "c", "d", "e"], ["Yes", "yes"], ["Yes", "  "]]) {
      const bad = ask({ question: "Hold?", options });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(bad.errors.join("\n")).toMatch(
          /ask options must be 2–4 distinct choices for a tappable card/u,
        );
      }
    }

    // No options at all: the host renders prose and nothing routes a typed reply back to the
    // question, so the run would wait out its timeout. Options are required.
    const freeText = ask({ question: "What's the one-time code?" });
    expect(freeText.ok).toBe(false);
    if (!freeText.ok) {
      expect(freeText.errors.join("\n")).toMatch(/params\.options: an ask needs 2–4 distinct/u);
    }
  });

  // Team v2 Task 6: `ask.target` names a Team member instead of always asking the owner, using the
  // same "team:<id>" shape `deliver.to` already uses.
  it('accepts an ask target of "owner" or "team:<id>", rejects anything else', () => {
    const ask = (target: unknown) =>
      validateDuty({
        ...baseDuty(),
        steps: [
          {
            id: "a1",
            kind: "ask",
            label: "Approve?",
            params: { question: "Hold this booking?", options: ["Approve", "Decline"], target },
          },
        ],
      });

    expect(ask(undefined).ok).toBe(true);
    expect(ask("owner").ok).toBe(true);
    expect(ask("team:ramesh").ok).toBe(true);

    for (const bad of ["team:", "", 7, "trigger"]) {
      const result = ask(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join("\n")).toMatch(
          /params\.target: must be "owner" or "team:<memberId>"/u,
        );
      }
    }
  });

  // Regression (I7): `validateStepParams` dispatched only to template/deliver, so an `ask` with no
  // question asked the owner a card that literally read "undefined", and an `ai` step with no
  // instruction sent "undefined" to the model.
  it("validates ask and ai params so an unset field never reaches a person or a model", () => {
    const bad = validateDuty({
      ...baseDuty(),
      steps: [
        { id: "a1", kind: "ask", label: "Ask", params: { options: ["Yes", "No"], header: 7 } },
        { id: "x1", kind: "ai", label: "Extract", params: { schema: "not-an-object" } },
      ],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const text = bad.errors.join("\n");
      expect(text).toMatch(/params\.question: must be a non-empty string/u);
      expect(text).toMatch(/params\.header: must be a string of at most 12 characters/u);
      expect(text).toMatch(/params\.instruction: must be a non-empty string/u);
      expect(text).toMatch(/params\.schema: must be an object/u);
    }

    expect(
      validateDuty({
        ...baseDuty(),
        steps: [
          {
            id: "x1",
            kind: "ai",
            label: "Extract",
            params: { instruction: "Pull the route", schema: { type: "object" } },
          },
        ],
      }).ok,
    ).toBe(true);
    // `schema` is optional; the runner defaults it to a plain object.
    expect(
      validateDuty({
        ...baseDuty(),
        steps: [{ id: "x1", kind: "ai", label: "Extract", params: { instruction: "Pull it" } }],
      }).ok,
    ).toBe(true);
  });

  it("rejects a cred placeholder inside template fill and deliver text", () => {
    const bad = validateDuty({
      ...baseDuty(),
      steps: [
        {
          id: "d1",
          kind: "deliver",
          label: "Send",
          params: { to: "owner", text: "{{cred:site.password}}" },
        },
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it("resolves nested input paths and file placeholders", async () => {
    const out = await resolvePlaceholders(
      "{{in:mail.attachments.0.text}} / {{in:mail.subject}} / {{file:t1}}",
      {
        out: {},
        in: { mail: { subject: "Ref G703", attachments: [{ text: "PDF TEXT" }] } },
        file: (id) => (id === "t1" ? "/tmp/x.pdf" : undefined),
      },
    );
    expect(out).toBe("PDF TEXT / Ref G703 / /tmp/x.pdf");
    await expect(resolvePlaceholders("{{file:zz}}", { out: {}, in: {} })).rejects.toThrow(
      /no file from step "zz"/u,
    );
  });

  it("validateRunInputs requires declared mail/file inputs with the right shape", () => {
    const duty = {
      ...baseDuty(),
      inputs: [
        { name: "mail", source: "mail" },
        { name: "sheet", source: "file", required: false },
      ],
    };
    // SAFETY: test fixture shaped like a Duty; validateRunInputs only reads inputs[].
    const d = duty as unknown as Duty;
    expect(validateRunInputs(d, {})).toEqual(['input "mail" is required']);
    expect(validateRunInputs(d, { mail: { from: "a@b", subject: "s" } })).toEqual([
      'input "mail": body must be a string',
    ]);
    expect(validateRunInputs(d, { mail: { from: "a@b", subject: "s", body: "b" } })).toEqual([]);
    expect(
      validateRunInputs(d, {
        mail: { from: "a@b", subject: "s", body: "b" },
        sheet: { name: "x" },
      }),
    ).toEqual(['input "sheet": path must be a string']);
  });
});

describe("deliver to a Team member", () => {
  const teamDeliverDuty = (params: Record<string, unknown>) => ({
    id: "t",
    name: "T",
    summary: "",
    status: "active",
    machine: "gateway",
    reportsTo: "owner",
    inputs: [],
    triggers: [{ kind: "manual" }],
    updatedAt: 1,
    steps: [{ id: "s1", label: "Send it", kind: "deliver", params }],
  });

  it("accepts to: team:<id> when a channel is named", () => {
    expect(
      validateDuty(teamDeliverDuty({ to: "team:ramesh", channel: "whatsapp", text: "done" })).ok,
    ).toBe(true);
  });

  it("rejects to: team:<id> with no channel, naming what is missing", () => {
    const result = validateDuty(teamDeliverDuty({ to: "team:ramesh", text: "done" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain(
        'channel: required when to is not "trigger" or "owner"',
      );
    }
  });

  it("names team:<memberId> in the bad-target message", () => {
    const result = validateDuty(teamDeliverDuty({ to: "", text: "done" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toContain(
        '.to: must be "trigger", "owner", "team:<memberId>", or a channel target',
      );
    }
  });

  it("leaves an existing owner-routed Duty valid and unchanged", () => {
    expect(validateDuty(teamDeliverDuty({ to: "owner", text: "done" })).ok).toBe(true);
    expect(validateDuty(teamDeliverDuty({ to: "trigger", text: "done" })).ok).toBe(true);
  });
});

describe("parseTeamRouteTarget", () => {
  it("returns the member id for a team: target and null for anything else", () => {
    expect(parseTeamRouteTarget("team:ramesh")).toBe("ramesh");
    expect(parseTeamRouteTarget("team:  ramesh  ")).toBe("ramesh");
    expect(parseTeamRouteTarget("team:")).toBeNull();
    expect(parseTeamRouteTarget("owner")).toBeNull();
    expect(parseTeamRouteTarget("+919812345678")).toBeNull();
  });
});
