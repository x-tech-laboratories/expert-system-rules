import { describe, expect, it } from "vitest";

import { explain, holds, infer, query, unify } from "../src/engine.ts";
import { parse_rule_set, parse_triple } from "../src/rule_set.ts";

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
  is_a: Instance of.
  subclass_of: Kind of.
  is: Property.
  in: Inside.
rules:
  - { id: T1, if: [?x is_a ?k, ?k subclass_of ?w], then: ?x is_a ?w }
  - { id: T2, if: [?x is_a bird, ?x is heavy], then: ?x is grounded }
  - { id: T3, if: [?x is_a bird, not ?x is grounded], then: ?x is flier }
  - { id: T4, if: [?x in ?y, ?y in ?z], then: ?x in ?z }
facts:
  - penguin subclass_of bird
  - bird subclass_of animal
`,
  "birds.yaml",
);

const t = parse_triple;

// ============================================================================
// Inference
// ============================================================================

describe("infer", () => {
  it("joins through variables and follows chains", () => {
    const inference = infer(rule_set, [t("pingu is_a penguin"), t("egg in nest"), t("nest in tree")]);

    expect(holds(inference, t("pingu is_a animal"))).toBe(true);
    expect(holds(inference, t("pingu is flier"))).toBe(true);
    expect(holds(inference, t("egg in tree"))).toBe(true);
  });

  it("settles a negated triple before reading it", () => {
    const inference = infer(rule_set, [t("pingu is_a penguin"), t("pingu is heavy")]);

    expect(holds(inference, t("pingu is grounded"))).toBe(true);
    expect(holds(inference, t("pingu is flier"))).toBe(false);
  });

  it("answers a pattern with every way to fill it in", () => {
    const inference = infer(rule_set, [t("pingu is_a penguin")]);

    expect(query(inference, t("pingu is_a ?kind"))).toEqual([{ "?kind": "penguin" }, { "?kind": "bird" }, { "?kind": "animal" }]);
    expect(query(inference, t("?who is flier"))).toEqual([{ "?who": "pingu" }]);
  });
});

describe("unify", () => {
  it("binds variables once and checks constants", () => {
    expect(unify(t("?x in ?x"), t("a in a"), {})).toEqual({ "?x": "a" });
    expect(unify(t("?x in ?x"), t("a in b"), {})).toBeNull();
    expect(unify(t("a in ?y"), t("b in c"), {})).toBeNull();
    expect(unify(t("a in ?y"), t("a is c"), {})).toBeNull();
  });
});

// ============================================================================
// Explaining
// ============================================================================

describe("explain", () => {
  it("traces a conclusion down to the given facts, including what is absent", () => {
    const inference = infer(rule_set, [t("pingu is_a penguin")]);

    expect(explain(rule_set, inference, t("pingu is flier"))).toEqual([
      "pingu is flier holds by T3: IF ?x is_a bird AND NOT ?x is grounded THEN ?x is flier",
      "  pingu is_a bird holds by T1: IF ?x is_a ?k AND ?k subclass_of ?w THEN ?x is_a ?w",
      "    pingu is_a penguin: given",
      "    penguin subclass_of bird: given",
      "  pingu is grounded does not hold",
      "    T2 fails at pingu is heavy",
      "      pingu is heavy does not hold: it is not given and no rule concludes it",
    ]);
  });

  it("shows where each rule fails, including a negation that holds", () => {
    const inference = infer(rule_set, [t("pingu is_a penguin"), t("pingu is heavy")]);

    expect(explain(rule_set, inference, t("pingu is flier"))).toEqual([
      "pingu is flier does not hold",
      "  T3 fails at NOT pingu is grounded",
      "    pingu is grounded holds by T2: IF ?x is_a bird AND ?x is heavy THEN ?x is grounded",
      "      pingu is_a bird holds by T1: IF ?x is_a ?k AND ?k subclass_of ?w THEN ?x is_a ?w",
      "        pingu is_a penguin: given",
      "        penguin subclass_of bird: given",
      "      pingu is heavy: given",
    ]);
  });

  it("stops at a pattern it cannot fill in and does not repeat itself", () => {
    const inference = infer(rule_set, []);

    expect(explain(rule_set, inference, t("egg in tree"))).toEqual(["egg in tree does not hold", "  T4 fails at egg in ?y"]);
    expect(explain(rule_set, inference, t("egg in tree"), 0, new Set(["egg in tree"]))).toEqual(["egg in tree: see above"]);
  });
});
