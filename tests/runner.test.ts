import { describe, expect, it } from "vitest";

import { build_prompt, parse_answer, rules_listing } from "../src/prompt.ts";
import { parse_rule_set } from "../src/rule_set.ts";
import { ask_model, check_cases, score } from "../src/runner.ts";

// ============================================================================
// Fixture
// ============================================================================

const rule_set = parse_rule_set(
  `
id: birds
title: Birds
license: CC-BY-SA-4.0
source: Test.
features:
  feathers: Feathers?
  heavy: Heavy?
rules:
  - { id: R1, if: [feathers], then: bird }
  - { id: R2, if: [bird, not heavy], then: flier }
cases:
  - { id: sparrow, facts: [feathers], expect: [bird, flier] }
  - { id: emu, facts: [feathers, heavy], expect: [bird, flier] }
  - { id: rock, facts: [], expect: [] }
`,
  "birds.yaml",
);

// ============================================================================
// Prompt and answers
// ============================================================================

describe("build_prompt", () => {
  it("states every rule, case and conclusion", () => {
    const prompt = build_prompt(rule_set);

    expect(prompt).toContain("R2: IF it is bird AND it is NOT heavy THEN it is flier");
    expect(prompt).toContain("emu: feathers, heavy");
    expect(prompt).toContain("rock: (no facts)");
    expect(prompt).toContain("from this set: bird, flier.");
  });

  it("lists rules compactly", () => {
    expect(rules_listing(rule_set)).toEqual(["R1: IF feathers THEN bird", "R2: IF bird AND NOT heavy THEN flier"]);
  });
});

describe("parse_answer", () => {
  it("reads JSON inside prose or a code fence", () => {
    const answers = parse_answer('Sure:\n```json\n{"sparrow": ["bird"], "rock": "none"}\n```');

    expect(answers).toEqual(new Map([["sparrow", ["bird"]], ["rock", []]]));
  });

  it("refuses an answer without a JSON object", () => {
    expect(() => parse_answer("no idea")).toThrow("the answer holds no JSON object");
    expect(() => parse_answer("{} [1]")).not.toThrow();
  });
});

// ============================================================================
// Scoring
// ============================================================================

describe("check_cases", () => {
  it("names what a case's expect gets wrong", () => {
    const [sparrow, emu, rock] = check_cases(rule_set);

    expect(sparrow).toEqual({ id: "sparrow", missing: [], extra: [] });
    expect(emu).toEqual({ id: "emu", missing: [], extra: ["flier"] });
    expect(rock).toEqual({ id: "rock", missing: [], extra: [] });
  });
});

describe("score", () => {
  it("counts every conclusion of every case as one cell", () => {
    const result = score(rule_set, new Map([["sparrow", ["bird"]], ["emu", ["bird", "flier", "dinosaur"]]]));

    expect(result.cases[0].missing).toEqual(["flier"]);
    expect(result.cases[1].extra).toEqual(["dinosaur", "flier"]);
    expect(result.correct_cells).toBe(4);
    expect(result.total_cells).toBe(6);
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
