import { describe, expect, it } from "vitest";

import { build_prompt, parse_answer, questions_of } from "../src/prompt.ts";
import { parse_rule_set, parse_triple } from "../src/rule_set.ts";
import { ask_model, check_cases, score } from "../src/runner.ts";

// ============================================================================
// Fixture
// ============================================================================

const rule_set = parse_rule_set(
  `
id: birds
title: Birds
version: 1.0.0
license: CC-BY-SA-4.0
source: Test.
relations:
  has: Has.
  is: Is.
rules:
  - { id: R1, if: [?x has feathers], then: ?x is bird }
  - { id: R2, if: [?x is bird, not ?x is heavy], then: ?x is flier }
facts:
  - rock is heavy
cases:
  - { id: sparrow, facts: [sparrow has feathers], expect: [sparrow is bird, sparrow is flier] }
  - { id: emu, facts: [emu has feathers, emu is heavy], expect: [emu is bird, emu is flier], expect_not: [emu is heavy] }
  - { id: rock, expect_not: [rock is bird] }
`,
  "birds.yaml",
);

// ============================================================================
// Prompt and answers
// ============================================================================

describe("build_prompt", () => {
  it("states relations, rules, shared facts, case facts and numbered questions", () => {
    const prompt = build_prompt(rule_set);

    expect(prompt).toContain("  has: Has.");
    expect(prompt).toContain("R2: IF ?x is bird AND NOT ?x is heavy THEN ?x is flier");
    expect(prompt).toContain("Facts that hold in every case:\n  rock is heavy");
    expect(prompt).toContain('  emu: facts: emu has feathers; emu is heavy\n    question 1: does "emu is bird" hold?');
    expect(prompt).toContain("  rock: facts: (none)");
  });

  it("leaves out empty sections", () => {
    const bare = { ...rule_set, relations: new Map(), facts: [] };

    expect(build_prompt(bare)).not.toContain("Relations:");
    expect(build_prompt(bare)).not.toContain("Facts that hold in every case:");
  });

  it("puts true questions before false ones", () => {
    expect(questions_of(rule_set.cases[1]).map(question => question.answer)).toEqual([true, true, false]);
  });
});

describe("parse_answer", () => {
  it("reads JSON inside prose or a code fence, accepting yes and no", () => {
    const answers = parse_answer('Sure:\n```json\n{"sparrow": [true, "yes", "No", 3], "rock": "none"}\n```');

    expect(answers).toEqual(new Map([["sparrow", [true, true, false, null]], ["rock", []]]));
  });

  it("refuses an answer without a JSON object", () => {
    expect(() => parse_answer("no idea")).toThrow("the answer holds no JSON object");
    expect(() => parse_answer("[1] {}")).not.toThrow();
  });
});

// ============================================================================
// Scoring
// ============================================================================

describe("check_cases", () => {
  it("names each question whose written answer the engine disagrees with", () => {
    const [sparrow, emu, rock] = check_cases(rule_set);

    expect(sparrow.wrong).toEqual([]);
    expect(emu.wrong).toEqual([
      { triple: parse_triple("emu is flier"), expected: false, got: true },
      { triple: parse_triple("emu is heavy"), expected: true, got: false },
    ]);
    expect(rock.wrong).toEqual([]);
  });
});

describe("score", () => {
  it("counts one point per question and treats a missing answer as wrong", () => {
    const result = score(rule_set, new Map([["sparrow", [true, false]], ["emu", [true, false, true]]]));

    expect(result.cases[0].wrong).toEqual([{ triple: parse_triple("sparrow is flier"), expected: true, got: false }]);
    expect(result.cases[2].wrong).toEqual([{ triple: parse_triple("rock is bird"), expected: false, got: null }]);
    expect(result.correct).toBe(4);
    expect(result.total).toBe(6);
  });
});

// ============================================================================
// Asking a model
// ============================================================================

describe("ask_model", () => {
  it("sends the prompt on stdin and returns stdout", async () => {
    const calls: unknown[] = [];
    const reply = await ask_model(["model", "-p"], "the prompt", async (argv, options) => {
      calls.push([argv, options.stdin]);
      return { exit_code: 0, stdout: "{}", stderr: "" };
    });

    expect(reply).toBe("{}");
    expect(calls).toEqual([[["model", "-p"], "the prompt"]]);
  });

  it("fails with the first line of stderr, or the exit code", async () => {
    await expect(ask_model(["model"], "p", async () => ({ exit_code: 1, stdout: "", stderr: "no key\nmore" }))).rejects.toThrow("model failed: no key");
    await expect(ask_model(["model"], "p", async () => ({ exit_code: 127, stdout: "", stderr: "" }))).rejects.toThrow("model failed: exit code 127");
  });
});
