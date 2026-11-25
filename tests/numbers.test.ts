import { describe, expect, it } from "vitest";

import { answer, explain, holds, infer } from "../src/engine.ts";
import { build_prompt } from "../src/prompt.ts";
import { compare, ground_layers, parse_rule_set, parse_triple, RuleSetError, stratify } from "../src/rule_set.ts";
import { check_cases, is_correct } from "../src/runner.ts";

// ============================================================================
// Helpers
// ============================================================================

const people = `
id: people
title: People
version: 1.0.0
license: CC-BY-SA-4.0
source: Test.
relations:
  age: Is this many years old.
  is: Is of this kind.
rules:
  - { id: N1, if: [?p age ?n, ?n less_than 18], then: ?p is minor }
  - { id: N2, if: [?p age ?n, not ?n less_than 18], then: ?p is adult }
  - { id: N3, if: [?p age ?n, ?n equal_to 65.0], then: ?p is retiring }
cases:
  - { id: ages, facts: [ana age 17, ben age 18, eve age -1, cy age 65, al age old], expect: [ana is minor, ben is adult, eve is minor, cy is retiring, al is adult], expect_not: [ben is minor, al is minor] }
`;

// A theory that only loops through "not" for kinds no single individual has at once.
const birds = `
id: birds
title: Birds
version: 1.0.0
license: CC-BY-SA-4.0
source: Test.
relations:
  is: Is of this kind.
  can: Is able to.
rules:
  - { id: B1, if: [?x is bird], then: ?x can fly, usually: true }
  - { id: B2, if: [?x is mammal], then: not ?x can fly, usually: true }
  - { id: B3, if: [?x can fly], then: ?x is airborne }
  - { id: B4, if: [?x is airborne], then: ?x can fly }
cases:
  - { id: two, facts: [tweety is bird, rex is mammal], expect: [tweety can fly, tweety is airborne], expect_not: [rex can fly] }
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
// Comparisons
// ============================================================================

describe("built-in comparisons", () => {
  it("compares numbers, and nothing else", () => {
    expect(compare(triple("10 greater_than 9"))).toBe(true);
    expect(compare(triple("-4 at_most 0"))).toBe(true);
    expect(compare(triple("0.5 at_most 0"))).toBe(false);
    expect(compare(triple("18 at_least 18"))).toBe(true);
    expect(compare(triple("65 equal_to 65.0"))).toBe(true);
    expect(compare(triple("old less_than 18"))).toBe(false);
  });

  it("runs comparisons and negated comparisons in rules", () => {
    const rule_set = parse_rule_set(people, "people.yaml");

    expect(check_cases(rule_set).every(is_correct)).toBe(true);
    expect(explain(rule_set, infer(rule_set, [triple("ben age 18")]), triple("ben is minor"))).toEqual(["ben is minor does not hold", "  N1 fails at 18 less_than 18, which is false"]);
  });

  it("refuses comparisons that are declared, stated, concluded or not filled in", () => {
    const text = people
      .replace("  is: Is of this kind.", "  is: Is of this kind.\n  less_than: Mine.")
      .replace("{ id: N3, if: [?p age ?n, ?n equal_to 65.0], then: ?p is retiring }", "{ id: N3, if: [?p age ?n, ?m equal_to 65], then: ?p less_than ?n }")
      .replace("facts: [ana age 17,", "facts: [1 less_than 2, ana age 17,");

    expect(problems_of(text)).toEqual([
      `relation "less_than" is built in; remove it from "relations"`,
      `rule N3: the comparison "less_than" can only be a condition`,
      `rule N3: ?m must appear in a condition without "not" that is not a comparison`,
      `the comparison "less_than" is worked out, not stated; it can only be a rule's condition`,
    ]);
  });

  it("tells the model what the comparisons mean", () => {
    expect(build_prompt(parse_rule_set(people, "people.yaml"))).toContain("less_than, greater_than, at_most, at_least, equal_to compare two numbers");
  });
});

// ============================================================================
// Layers triple by triple
// ============================================================================

describe("per-individual layering", () => {
  it("accepts rules that only loop through not for kinds no individual has at once", () => {
    const rule_set = parse_rule_set(birds, "birds.yaml");

    expect(stratify(rule_set.rules, rule_set.cases[0].facts)).toBeNull();
    expect(rule_set.rule_strata).toBeNull();
    expect(check_cases(rule_set).every(is_correct)).toBe(true);
    const inference = infer(rule_set, rule_set.cases[0].facts);
    expect(answer(rule_set, inference, triple("rex can fly"))).toBe(false);
    expect(holds(inference, triple("tweety is airborne"))).toBe(true);
  });

  it("refuses facts that make an individual loop, when loading and when inferring", () => {
    const rule_set = parse_rule_set(birds, "birds.yaml");

    expect(() => infer(rule_set, [triple("bat is bird"), triple("bat is mammal")])).toThrow("birds: with these facts a conclusion depends on its own negation: bat can fly, bat is airborne, not bat can fly");
    expect(problems_of(birds.replace("facts: [tweety is bird, rex is mammal]", "facts: [tweety is bird, tweety is mammal]"))).toEqual([
      "in case two, a conclusion depends on its own negation, so the rules have no single answer: not tweety can fly, tweety can fly, tweety is airborne",
    ]);
    expect(problems_of(birds.replace(/cases:[\s\S]*$/, "facts: [x is bird, x is mammal]\n"))).toEqual([
      "a conclusion depends on its own negation, so the rules have no single answer: not x can fly, x can fly, x is airborne",
    ]);
  });

  it("orders filled-in rules so a not is read after its triple settles", () => {
    const rule_set = parse_rule_set(birds, "birds.yaml");
    const plan = ground_layers(rule_set.rules, [triple("tweety is bird")]);

    expect(plan.loop).toBeNull();
    const heads = plan.groups!.map(group => group.map(instance => `${instance.rule.id} ${instance.head.subject} ${instance.head.relation} ${instance.head.object}`));
    expect(heads).toEqual([["B1 tweety can fly", "B3 tweety is airborne", "B4 tweety can fly"]]);
  });
});
