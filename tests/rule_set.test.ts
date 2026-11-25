import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { list_rule_set_files, parse_rule_set, parse_triple, rule_text, RuleSetError, stratify } from "../src/rule_set.ts";

// ============================================================================
// Helpers
// ============================================================================

const valid = `
id: tiny
title: Tiny
license: CC-BY-SA-4.0
source: Test.
tags: [test]
relations:
  is: Has this property.
  in: Is inside this.
rules:
  - { id: A, if: [?x is wet, ?x is cold], then: ?x is ice }
  - { id: B, if: [?x is wet, not ?x is ice], then: ?x is water }
  - { id: C, if: [?x in ?y, ?y in ?z], then: ?x in ?z }
facts:
  - cup in kitchen
cases:
  - { id: frozen, facts: [pond is wet, pond is cold], expect: [pond is ice], expect_not: [pond is water] }
  - { id: 7, note: A number id., facts: [tea in cup], expect: [tea in kitchen] }
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
  it("reads triples, negated conditions and layers", () => {
    const rule_set = parse_rule_set(valid, "test.yaml");

    expect(rule_set.id).toBe("tiny");
    expect(rule_set.tags).toEqual(["test"]);
    expect(rule_set.facts).toEqual([{ subject: "cup", relation: "in", object: "kitchen" }]);
    expect(rule_set.rules[1].conditions[1]).toEqual({ subject: "?x", relation: "is", object: "ice", negated: true });
    expect(rule_set.rule_strata).toEqual(new Map([["A", 0], ["B", 1], ["C", 0]]));
    expect(rule_set.cases[1]).toMatchObject({ id: "7", note: "A number id.", expect_not: [] });
  });

  it("names malformed triples and undeclared relations", () => {
    const text = valid
      .replace("[?x is wet, not ?x is ice]", "[?x is wet, never ?x is ice]")
      .replace("then: ?x in ?z", "then: ?x near ?z")
      .replace("- cup in kitchen", "- Cup in ?kitchen")
      .replace("expect: [tea in kitchen]", "expect: [tea]");

    expect(problems_of(text)).toEqual([
      `fact 1: "Cup" must be a lower_snake_case name`,
      `fact 1: "?kitchen" must be a lower_snake_case name`,
      `rule B condition 2 must be "subject relation object", optionally after "not", not "never ?x is ice"`,
      `case 7 expect 1 must be "subject relation object", not "tea"`,
      `the relation "near" is used but not listed under "relations"`,
    ]);
  });

  it("refuses variables that only a negation or the conclusion would fill in", () => {
    const text = valid.replace("{ id: B, if: [?x is wet, not ?x is ice], then: ?x is water }", "{ id: B, if: [not ?y is ice], then: ?z is water }");

    expect(problems_of(text)).toEqual([`rule B: ?z must appear in a condition without "not"`, `rule B: ?y must appear in a condition without "not"`]);
  });

  it("refuses a conclusion that depends on its own negation", () => {
    const text = valid.replace("{ id: A, if: [?x is wet, ?x is cold], then: ?x is ice }", "{ id: A, if: [?x is wet, not ?x is water], then: ?x is ice }");

    expect(problems_of(text)).toContain("a conclusion depends on its own negation, so the rules have no single answer");
  });

  it("refuses duplicate ids, empty rules and cases without questions", () => {
    const text = `
id: bad
title: Bad
license: MIT
source: Test.
relations: { is: Is., Bad-Name: "" }
rules:
  - { id: A, if: [?x is wet], then: ?x is ice }
  - { id: A, if: [], then: ?x is ice }
  - { id: D, if: [?x is wet] }
  - just text
  - { if: [?x is wet], then: ?x is dry }
facts: nope
cases:
  - { id: one, expect: [x is ice] }
  - { id: one }
  - nonsense
  - { expect: [x is ice] }
`;

    expect(problems_of(text)).toEqual([
      `relation "Bad-Name" must be lower_snake_case`,
      `relation "Bad-Name" needs a meaning`,
      "fact must be a list",
      `rule id "A" is used twice`,
      `rule A needs a list of conditions under "if"`,
      `rule D "then" must be "subject relation object", not undefined`,
      "rule 4 must be a mapping with id, if and then",
      "rule 5 needs an id",
      `case id "one" is used twice`,
      "case one needs at least one question under expect or expect_not",
      "case 3 must be a mapping with id and questions under expect or expect_not",
      "case 4 needs an id",
    ]);
  });

  it("refuses missing top-level fields and non-mappings", () => {
    expect(problems_of("id: x\nrules: nope\ncases: nope\nrelations: []")).toEqual([
      `"title" must be a non-empty string`,
      `"license" must be a non-empty string`,
      `"source" must be a non-empty string`,
      `"relations" must map each relation name to what it means`,
      `"rules" must be a non-empty list`,
      `"cases" must be a list`,
    ]);
    expect(problems_of("- a list")).toEqual(["the file must hold a mapping"]);
    expect(problems_of("id: [unclosed")[0]).toMatch(/^not valid YAML/);
    expect(problems_of(valid.replace("tags: [test]", "tags: test"))).toEqual([`"tags" must be a list of names`]);
  });
});

// ============================================================================
// Triples
// ============================================================================

describe("parse_triple", () => {
  it("reads a typed triple, variables allowed", () => {
    expect(parse_triple("  cheese in ?where ")).toEqual({ subject: "cheese", relation: "in", object: "?where" });
    expect(() => parse_triple("cheese in")).toThrow(`the triple must be "subject relation object", not "cheese in"`);
    expect(() => parse_triple("cheese In fridge")).toThrow(`the relation "In" must be a lower_snake_case name`);
  });

  it("writes a rule as one line", () => {
    expect(rule_text(parse_rule_set(valid, "test.yaml").rules[1])).toBe("B: IF ?x is wet AND NOT ?x is ice THEN ?x is water");
  });
});

// ============================================================================
// Layers
// ============================================================================

describe("stratify", () => {
  const triple = (text: string) => parse_triple(text);

  it("separates kinds by their fixed object and allows positive loops", () => {
    const rules = [
      { id: "1", conditions: [{ ...triple("?x is a"), negated: false }], conclusion: triple("?x is b") },
      { id: "2", conditions: [{ ...triple("?x is b"), negated: false }], conclusion: triple("?x is a") },
      { id: "3", conditions: [{ ...triple("?x is a"), negated: false }, { ...triple("?x is b"), negated: true }], conclusion: triple("?x is c") },
    ];

    expect(stratify(rules, [triple("seed is a")])).toEqual(new Map([["1", 0], ["2", 0], ["3", 1]]));
  });

  it("separates kinds by their fixed subject too", () => {
    const rules = [
      { id: "1", conditions: [{ ...triple("rabbit is a"), negated: false }], conclusion: triple("rabbit is b") },
      { id: "2", conditions: [{ ...triple("rabbit is b"), negated: false }, { ...triple("cat is b"), negated: true }], conclusion: triple("rabbit is a") },
    ];

    expect(stratify(rules, [])).toEqual(new Map([["1", 1], ["2", 1]]));
  });

  it("treats a variable object as every object of that relation", () => {
    const rules = [{ id: "1", conditions: [{ ...triple("?x is a"), negated: false }, { ...triple("?x is ?y"), negated: true }], conclusion: triple("?x is b") }];

    expect(stratify(rules, [])).toBeNull();
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
