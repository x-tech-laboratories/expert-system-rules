import { describe, expect, it } from "vitest";

import { convert_theory, type ProofWriterRecord } from "../src/importers/proofwriter.ts";
import { atom, sample_record } from "./fixtures/proofwriter.ts";
import { parse_rule_set } from "../src/rule_set.ts";
import { check_cases, is_correct } from "../src/runner.ts";

// ============================================================================
// Fixtures
// ============================================================================

function with_changes(changes: Partial<ProofWriterRecord>): ProofWriterRecord {
  return { ...sample_record, ...changes };
}

// ============================================================================
// Converting
// ============================================================================

describe("convert_theory", () => {
  it("writes a rule set the engine answers exactly as ProofWriter does", () => {
    const rule_set = parse_rule_set(convert_theory(sample_record), "sample");

    expect(rule_set.id).toBe("relneg-cwa-d1-7");
    expect(rule_set.description).toBe(sample_record.theory);
    expect(check_cases(rule_set).every(is_correct)).toBe(true);
    expect(rule_set.cases[0].expect.length + rule_set.cases[0].expect_not.length).toBe(4);
  });

  it("turns names into snake_case, ~ into not, and someone or something into ?x", () => {
    const yaml = convert_theory(sample_record);

    expect(yaml).toContain("  - { id: R1, if: [?x is big, not ?x needs cow], then: ?x chases cow }");
    expect(yaml).toContain("  - bald_eagle is big");
    expect(yaml).toContain("  visits: The subject visits the object.");
    expect(yaml).toContain("  - { id: R3, if: [cow needs ?x], then: ?x is needed }");
  });

  it("guards a variable that only appears under not, and lists every entity as a thing", () => {
    const yaml = convert_theory(sample_record);

    expect(yaml).toContain("  - { id: R2, if: [?x is_a thing, not ?x is quiet], then: ?x is loud }");
    expect(yaml).toContain("  - bald_eagle is_a thing\n  - cow is_a thing\n");
    expect(yaml).toContain("  is_a: The subject is one of the things the theory talks about.");
  });

  it("refuses what the format cannot hold", () => {
    expect(() => convert_theory(with_changes({ triples: { triple1: { representation: atom("cow", "is", "big", "-") } } }))).toThrow("only positive facts");
    expect(() => convert_theory(with_changes({ rules: { rule1: { representation: `((${atom("cow", "is", "big")}) -> ${atom("cow", "is", "red", "-")})` } } }))).toThrow("only positive conclusions");
    expect(() => convert_theory(with_changes({ rules: { rule1: { representation: `(() -> ${atom("cow", "is", "red")})` } } }))).toThrow("no conditions");
    expect(() => convert_theory(with_changes({ rules: { rule1: { representation: `((${atom("cow", "is", "big", "?")}) -> ${atom("cow", "is", "red")})` } } }))).toThrow("unknown polarity ?");
    expect(() => convert_theory(with_changes({ triples: { triple1: { representation: "nothing here" } } }))).toThrow("expected one statement");
    expect(() => convert_theory(with_changes({ rules: { rule1: { representation: atom("cow", "is", "red") } } }))).toThrow("rule1 conclusion: expected one statement");
  });

  it("refuses unknown answers, unknown polarities and contradicting questions", () => {
    const question = (answer: boolean | string, polarity = "+") => ({ question: "?", answer, representation: atom("cow", "is", "big", polarity) });

    expect(() => convert_theory(with_changes({ questions: { Q1: question("Unknown") } }))).toThrow(`answer "Unknown" is not true or false`);
    expect(() => convert_theory(with_changes({ questions: { Q1: question(true, "~") } }))).toThrow("unknown polarity ~");
    expect(() => convert_theory(with_changes({ questions: { Q1: question(true), Q2: question(true, "-") } }))).toThrow(`contradicts an earlier question about "cow is big"`);
  });
});
