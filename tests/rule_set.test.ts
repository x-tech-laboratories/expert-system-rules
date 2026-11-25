import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { list_rule_set_files, parse_rule_set, RuleSetError, stratify } from "../src/rule_set.ts";

// ============================================================================
// Helpers
// ============================================================================

const valid = `
id: tiny
title: Tiny
license: CC-BY-SA-4.0
source: Test.
tags: [test]
features:
  wet: Is it wet?
  cold: Is it cold?
goals: [ice]
rules:
  - { id: A, if: [wet, cold], then: ice }
  - { id: B, if: [wet, not ice], then: water }
cases:
  - { id: frozen, facts: [wet, cold], expect: [ice] }
  - { id: 7, note: A number id., facts: [wet], expect: [water] }
`;

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
// Parsing
// ============================================================================

describe("parse_rule_set", () => {
  it("reads a valid rule set with negated conditions and layers", () => {
    const rule_set = parse_rule_set(valid, "test.yaml");

    expect(rule_set.id).toBe("tiny");
    expect(rule_set.tags).toEqual(["test"]);
    expect(rule_set.conclusions).toEqual(["ice", "water"]);
    expect(rule_set.rules[1].conditions[1]).toEqual({ fact: "ice", negated: true });
    expect(rule_set.strata.get("water")).toBe(1);
    expect(rule_set.cases[1]).toMatchObject({ id: "7", note: "A number id." });
  });

  it("names unknown facts, unknown goals and bad cases", () => {
    const text = valid
      .replace("[wet, not ice]", "[wett, not ice]")
      .replace("goals: [ice]", "goals: [steam]")
      .replace("facts: [wet, cold]", "facts: [wet, hot]")
      .replace("expect: [ice] }", "expect: [fog] }");

    expect(problems_of(text)).toEqual([
      `rule B uses "wett", which is neither a feature nor a conclusion`,
      `goal "steam" is not concluded by any rule`,
      `case frozen gives "hot", which is not a feature`,
      `case frozen expects "fog", which no rule concludes`,
    ]);
  });

  it("refuses a conclusion that depends on its own negation", () => {
    const text = valid.replace("{ id: A, if: [wet, cold], then: ice }", "{ id: A, if: [not water], then: ice }");

    expect(problems_of(text)).toContain("a conclusion depends on its own negation, so the rules have no single answer");
  });

  it("refuses duplicate ids, a rule concluding a feature and malformed entries", () => {
    const text = `
id: bad
title: Bad
license: MIT
source: Test.
features: { wet: Is it wet?, Bad-Name: "" }
rules:
  - { id: A, if: [wet], then: wet }
  - { id: A, if: [], then: Not A Name }
  - just text
cases:
  - { id: one }
  - { id: one, facts: wet }
  - nonsense
`;

    expect(problems_of(text)).toEqual([
      `feature "Bad-Name" must be lower_snake_case`,
      `feature "Bad-Name" needs a question`,
      `rule A concludes "wet", which is a feature; features are only ever given`,
      `rule id "A" is used twice`,
      "rule A needs at least one condition",
      `rule A "then" must be one lower_snake_case name`,
      "rule 3 must be a mapping with id, if and then",
      `case id "one" is used twice`,
      `case one "facts" must be a list of names`,
      "case 3 must be a mapping with id, facts and expect",
    ]);
  });

  it("refuses missing top-level fields and non-mappings", () => {
    expect(problems_of("id: x\nrules: nope\ncases: nope\nfeatures: []")).toEqual([
      `"title" must be a non-empty string`,
      `"license" must be a non-empty string`,
      `"source" must be a non-empty string`,
      `"features" must map each feature name to its question`,
      `"rules" must be a non-empty list`,
      `"cases" must be a list`,
    ]);
    expect(problems_of("- a list")).toEqual(["the file must hold a mapping"]);
    expect(problems_of("id: [unclosed")[0]).toMatch(/^not valid YAML/);
  });

  it("reports rules without an id by position", () => {
    const text = valid.replace("{ id: A, if: [wet, cold], then: ice }", "{ if: [wet, cold], then: ice }");

    expect(problems_of(text)).toEqual(["rule 1 needs an id"]);
  });

  it("reports cases without an id by position", () => {
    expect(problems_of(valid.replace("{ id: frozen,", "{"))).toEqual(["case 1 needs an id"]);
  });
});

// ============================================================================
// Layers
// ============================================================================

describe("stratify", () => {
  it("allows positive loops and puts negations a layer higher", () => {
    const features = new Map([["seed", "?"]]);
    const strata = stratify(
      [
        { id: "1", conditions: [{ fact: "seed", negated: false }], conclusion: "a" },
        { id: "2", conditions: [{ fact: "a", negated: false }], conclusion: "b" },
        { id: "3", conditions: [{ fact: "b", negated: false }], conclusion: "a" },
        { id: "4", conditions: [{ fact: "a", negated: true }], conclusion: "c" },
      ],
      features,
    );

    expect(strata).toEqual(new Map([["a", 0], ["b", 0], ["c", 1]]));
  });
});

// ============================================================================
// Listing
// ============================================================================

describe("list_rule_set_files", () => {
  it("finds YAML files in subject folders in path order", async () => {
    const folder = await mkdtemp(join(tmpdir(), "rule-sets-"));
    await mkdir(join(folder, "b"));
    await writeFile(join(folder, "b", "two.yml"), "");
    await writeFile(join(folder, "a.yaml"), "");
    await writeFile(join(folder, "notes.md"), "");

    expect(await list_rule_set_files(folder)).toEqual([join(folder, "a.yaml"), join(folder, "b", "two.yml")]);
  });
});
