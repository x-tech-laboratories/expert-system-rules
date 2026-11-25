import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run_cli } from "../src/cli.ts";
import { answer, explain, holds, infer } from "../src/engine.ts";
import { build_prompt, parse_answer } from "../src/prompt.ts";
import { opposite, parse_rule_set, parse_triple, rule_text, RuleSetError, triple_text } from "../src/rule_set.ts";
import { check_cases, score } from "../src/runner.ts";

// ============================================================================
// Helpers
// ============================================================================

const birds = `
id: birds
title: Birds
version: 1.0.0
license: CC-BY-SA-4.0
source: Test.
relations:
  is: Is of this kind.
  can: { meaning: Is able to., world: open }
  has: Has this part.
rules:
  - { id: D1, if: [?x is bird], then: ?x can fly, usually: true }
  - { id: D2, if: [?x is penguin], then: not ?x can fly }
  - { id: D3, if: [?x is bird], then: ?x has feathers, usually: true }
  - { id: D4, if: [?x is plucked], then: not ?x has feathers }
  - { id: D5, if: [?x is penguin], then: ?x is bird }
  - { id: D6, if: [?x is rocket], then: ?x can fly }
facts:
  - not opus has feathers
cases:
  - { id: tweety, facts: [tweety is bird], expect: [tweety can fly, tweety has feathers] }
  - { id: pingu, facts: [pingu is penguin], expect: [pingu is bird], expect_not: [pingu can fly] }
  - { id: rex, facts: [rex is dog], expect_unknown: [rex can fly], expect_not: [rex has feathers] }
  - { id: opus, facts: [opus is bird], expect_not: [opus has feathers] }
`;

const triple = parse_triple;

function problems_of(text: string): string[] {
  try {
    parse_rule_set(text, "test.yaml");
  } catch (error) {
    if (error instanceof RuleSetError) return error.problems;
    throw error;
  }
  return [];
}

// ============================================================================
// Reading
// ============================================================================

describe("defaults and denials in the format", () => {
  it("reads usually, denied conclusions and denied facts", () => {
    const rule_set = parse_rule_set(birds, "birds.yaml");

    expect(rule_set.rules[0].usually).toBe(true);
    expect(triple_text(rule_set.rules[1].conclusion)).toBe("not ?x can fly");
    expect(triple_text(rule_set.facts[0])).toBe("not opus has feathers");
    expect(rule_text(rule_set.rules[0])).toBe("D1: IF ?x is bird THEN USUALLY ?x can fly");
    expect(rule_text(rule_set.rules[1])).toBe("D2: IF ?x is penguin THEN NOT ?x can fly");
    expect(rule_set.relations.get("can")?.world).toBe("open");
    expect(rule_set.world).toBe("closed");
    expect(opposite(opposite(triple("a is b")))).toEqual(triple("a is b"));
  });

  it("refuses a bad world or usually, and not on an open-world relation", () => {
    const text = birds
      .replace("source: Test.", "source: Test.\nworld: sideways")
      .replace("world: open }", "world: maybe }")
      .replace("usually: true }", "usually: often }")
      .replace("{ id: D6, if: [?x is rocket]", "{ id: D6, if: [?x is rocket, not ?x can glide]");

    expect(problems_of(text)).toEqual([
      `"world" must be closed or open, not "sideways"`,
      `relation "can": "world" must be closed or open, not "maybe"`,
      `rule D1: "usually" must be true or false`,
    ]);
    expect(problems_of(birds.replace("{ id: D6, if: [?x is rocket]", "{ id: D6, if: [?x is rocket, not ?x can glide]"))).toEqual([
      `rule D6: "not ?x can glide" reads the open-world relation "can", where a missing triple is unknown; conclude "not ..." in an exception and mark this rule "usually" instead`,
    ]);
  });

  it("refuses two defaults that override each other", () => {
    const text = birds.replace("{ id: D2, if: [?x is penguin], then: not ?x can fly }", "{ id: D2, if: [?x is penguin], then: not ?x can fly, usually: true }");

    expect(problems_of(text)).toEqual(["a conclusion depends on its own negation, so the rules have no single answer"]);
  });

  it("takes the world of the whole rule set when a relation does not say", () => {
    const open = parse_rule_set(birds.replace("source: Test.", "source: Test.\nworld: open"), "birds.yaml");
    const inference = infer(open, [triple("rex is dog")]);

    expect(answer(open, inference, triple("rex is cat"))).toBe("unknown");
    expect(answer(open, inference, opposite(triple("rex is cat")))).toBe(false);
  });
});

// ============================================================================
// Inference
// ============================================================================

describe("defaults and denials in the engine", () => {
  const rule_set = parse_rule_set(birds, "birds.yaml");

  it("answers true, false and unknown, and every case matches", () => {
    expect(check_cases(rule_set).every(result => result.wrong.length === 0 && result.conflicts.length === 0)).toBe(true);
    const inference = infer(rule_set, [triple("pingu is penguin")]);
    expect(answer(rule_set, inference, triple("pingu can fly"))).toBe(false);
    expect(answer(rule_set, inference, triple("pingu has feathers"))).toBe(true);
    expect(answer(rule_set, inference, triple("pingu can swim"))).toBe("unknown");
    expect(answer(rule_set, inference, triple("pingu is fish"))).toBe(false);
  });

  it("reports a strict conclusion that is also denied as a conflict", () => {
    const inference = infer(rule_set, [triple("pingu is penguin"), triple("pingu is rocket")]);

    expect(inference.conflicts).toEqual([triple("pingu can fly")]);
    expect(holds(inference, triple("pingu can fly"))).toBe(true);
  });

  it("explains an overridden default, a denial and an unknown", () => {
    const inference = infer(rule_set, [triple("pingu is penguin")]);

    expect(explain(rule_set, inference, triple("pingu can fly"))).toEqual([
      "pingu can fly is false",
      "  not pingu can fly holds by D2: IF ?x is penguin THEN NOT ?x can fly",
      "    pingu is penguin: given",
      '  D1 usually concludes it, but the exception "not pingu can fly" holds',
      "  D6 fails at pingu is rocket",
      "    pingu is rocket does not hold: it is not given and no rule concludes it",
    ]);
    expect(explain(rule_set, inference, triple("pingu can swim"))).toEqual(["pingu can swim is unknown (can is open-world): it is not given and no rule concludes it"]);
    expect(explain(rule_set, infer(rule_set, [triple("opus is bird")]), triple("opus has feathers"))).toEqual([
      "opus has feathers is false",
      "  not opus has feathers: given",
      '  D3 usually concludes it, but the exception "not opus has feathers" holds',
    ]);
  });
});

// ============================================================================
// Prompt, answers and scoring
// ============================================================================

describe("unknown answers from a model", () => {
  const rule_set = parse_rule_set(birds, "birds.yaml");

  it("tells the model about defaults, denials and open-world relations", () => {
    const prompt = build_prompt(rule_set);

    expect(prompt).toContain("'THEN USUALLY x' is a default");
    expect(prompt).toContain("These relations are open-world: can.");
    expect(prompt).toContain(`Answer every question with true, false or "unknown".`);
    expect(prompt).toContain("question 2: does \"rex can fly\" hold?");
  });

  it("leaves defaults and unknowns out of a plain closed-world prompt", () => {
    const plain = parse_rule_set("id: p\ntitle: P\nversion: 1.0.0\nlicense: X\nsource: Y\nrelations: { is: Is. }\nrules: [{ id: A, if: [?x is a], then: ?x is b }]\ncases: [{ id: c, expect: [x is b] }]", "plain.yaml");
    const prompt = build_prompt(plain);

    expect(prompt).not.toContain("USUALLY");
    expect(prompt).not.toContain("unknown");
  });

  it("reads and scores unknown answers", () => {
    const answers = parse_answer('{"tweety": [true, true], "pingu": [true, false], "rex": [false, "Unknown"], "opus": ["unknown"]}');

    expect(answers.get("rex")).toEqual([false, "unknown"]);
    const result = score(rule_set, answers);
    expect(result.correct).toBe(6);
    expect(result.cases.find(item => item.id === "opus")?.wrong).toEqual([{ triple: triple("opus has feathers"), expected: false, got: "unknown" }]);
  });
});

// ============================================================================
// Checking from the command line
// ============================================================================

describe("check", () => {
  it("fails on a conflict and shows unknown answers", async () => {
    const folder = await mkdtemp(join(tmpdir(), "esr-defaults-"));
    await mkdir(join(folder, "rulesets", "animals"), { recursive: true });
    const text = birds.replace("expect_unknown: [rex can fly]", "expect: [rex can fly]") + "  - { id: clash, facts: [x is penguin, x is rocket], expect: [x is bird] }\n";
    await writeFile(join(folder, "rulesets", "animals", "birds.yaml"), text);
    let out = "";
    const code = await run_cli(["check"], { cwd: folder, out: { write: chunk => void (out += chunk) }, err: { write: () => undefined } });

    expect(code).toBe(1);
    expect(out).toBe(
      [
        "birds: 6 rules, 1 facts, 3/5 cases match the engine",
        `  rex: "rex can fly" is unknown by the engine, the case says true`,
        `  clash: "x can fly" is concluded both to hold and to be false`,
        "",
      ].join("\n"),
    );
  });
});
