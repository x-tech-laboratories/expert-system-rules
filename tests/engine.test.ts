import { describe, expect, it } from "vitest";

import { conclusions_for, explain, infer, rule_text } from "../src/engine.ts";
import { parse_rule_set } from "../src/rule_set.ts";

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
  - { id: R2, if: [bird, heavy], then: grounded }
  - { id: R3, if: [bird, not grounded], then: flier }
`,
  "birds.yaml",
);

// ============================================================================
// Inference
// ============================================================================

describe("infer", () => {
  it("settles a negated fact before reading it", () => {
    expect(conclusions_for(rule_set, ["feathers"])).toEqual(["bird", "flier"]);
    expect(conclusions_for(rule_set, ["feathers", "heavy"])).toEqual(["bird", "grounded"]);
    expect(conclusions_for(rule_set, [])).toEqual([]);
  });

  it("records the rule behind each conclusion", () => {
    const { reasons } = infer(rule_set, ["feathers"]);

    expect(reasons.get("flier")?.id).toBe("R3");
  });
});

// ============================================================================
// Explaining
// ============================================================================

describe("explain", () => {
  it("traces a conclusion down to the given features", () => {
    const lines = explain(rule_set, infer(rule_set, ["feathers"]), "flier");

    expect(lines).toEqual([
      "flier holds by R3: IF bird AND NOT grounded THEN flier",
      "  bird holds by R1: IF feathers THEN bird",
      "    feathers: given",
      "  grounded does not hold",
      "    R2 fails at heavy",
      "      heavy: not given",
    ]);
  });

  it("shows where each rule fails and does not repeat itself", () => {
    const lines = explain(rule_set, infer(rule_set, ["feathers", "heavy"]), "flier");

    expect(lines).toEqual([
      "flier does not hold",
      "  R3 fails at NOT grounded",
      "    grounded holds by R2: IF bird AND heavy THEN grounded",
      "      bird holds by R1: IF feathers THEN bird",
      "        feathers: given",
      "      heavy: given",
    ]);
    expect(explain(rule_set, infer(rule_set, []), "bird", 0, new Set(["bird"]))).toEqual(["bird: see above"]);
  });

  it("writes a rule as one line", () => {
    expect(rule_text(rule_set.rules[2])).toBe("R3: IF bird AND NOT grounded THEN flier");
  });
});
