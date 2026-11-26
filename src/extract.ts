// Asks a model to turn a theory written in English into facts and rules, and scores those rules by how the engine then answers the theory's questions.

// ── Imports ──────────────────────────────────────────────────────────────────

import { parse, stringify } from "yaml";

import { questions_of } from "./prompt.ts";
import { is_variable, parse_rule_set, type RuleSet, type RuleSetError } from "./rule_set.ts";
import { check_cases } from "./runner.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// A theory to extract: its English, and the reference rule set whose relations, names and questions the model's rules are scored on.
export interface ExtractionTask {
  id: string;
  english: string;
  reference_yaml: string;
  reference: RuleSet;
}

export interface ExtractionScore {
  id: string;
  correct: number;
  total: number;
  // Why the model's rules could not be used, or "".
  problem: string;
}

const guard_relation = "is_a";
const guard_meaning = "The subject is one of the things the theory talks about.";

// ── Prompt ───────────────────────────────────────────────────────────────────

// The names a theory uses, so the model writes the same ones the questions ask about.
function names_of(rule_set: RuleSet): string[] {
  const triples = [...rule_set.facts, ...rule_set.rules.flatMap(rule => [rule.conclusion, ...rule.conditions]), ...rule_set.cases.flatMap(entry => [...entry.facts, ...entry.expect, ...entry.expect_not])];
  return [...new Set(triples.flatMap(triple => [triple.subject, triple.object]).filter(term => !is_variable(term) && term !== "thing"))].sort();
}

export function extraction_prompt(task: ExtractionTask): string {
  const relations = new Map([...task.reference.relations].map(([name, relation]) => [name, relation.meaning]));
  if (!relations.has(guard_relation)) relations.set(guard_relation, guard_meaning);
  return [
    "Translate the theory below into facts and rules for a rule engine. Do not answer any questions; only translate.",
    "",
    "Theory:",
    task.english,
    "",
    'Write every statement as a triple "subject relation object", such as "bob is big" or "the_cat likes the_dog".',
    `Use only these relations: ${[...relations].map(([name, meaning]) => `${name} (${meaning})`).join("; ")}.`,
    `Use these names for individuals and properties, in lower_snake_case: ${names_of(task.reference).join(", ")}.`,
    "Rules use variables written ?x, ?y for 'something' or 'someone'. A rule is { id: R1, if: [conditions], then: conclusion }.",
    'A condition may start with "not": it then holds when its triple cannot be concluded at all (closed world).',
    "Every variable in a not condition or in the conclusion must also appear in a condition without not.",
    `For a rule like "if something is not big then it is red", add the condition "?x ${guard_relation} thing" and a fact "<name> ${guard_relation} thing" for every individual.`,
    "",
    "Answer with YAML only, in this shape:",
    "facts:",
    "  - bob is big",
    "rules:",
    "  - { id: R1, if: [?x is big, not ?x is red], then: ?x is blue }",
  ].join("\n");
}

// ── Grammar ──────────────────────────────────────────────────────────────────

// A llama.cpp GBNF grammar that only lets a model write the reply's shape: facts of the theory's names and relations,
// then rules whose conditions and conclusion are triples of those names and ?x, ?y or ?z. It cannot check that every
// variable is filled in, which loading still does.
export function extraction_grammar(task: ExtractionTask): string {
  const literal = (word: string) => JSON.stringify(word);
  const relations = [...new Set([...task.reference.relations.keys(), guard_relation])].sort();
  const names = [...new Set([...names_of(task.reference), "thing"])].sort();
  // A small model at temperature 0 can repeat a line until it runs out of tokens, so the counts are bounded:
  // no more rules than the theory has sentences, and room for several facts per sentence plus each name's guard.
  const sentences = task.english.split(/[.!?](?:\s|$)/).filter(text => text.trim()).length;
  return [
    `root ::= "facts:\\n" fact{0,${sentences * 4 + names.length}} "rules:\\n" rule{1,${sentences}}`,
    'fact ::= "  - " name " " relation " " name "\\n"',
    'rule ::= "  - { id: R" [1-9] [0-9]? ", if: [" condition (", " condition)* "], then: " term " " relation " " term " }\\n"',
    'condition ::= "not "? term " " relation " " term',
    "term ::= name | variable",
    'variable ::= "?x" | "?y" | "?z"',
    `name ::= ${names.map(literal).join(" | ")}`,
    `relation ::= ${relations.map(literal).join(" | ")}`,
    "",
  ].join("\n");
}

// ── Scoring ──────────────────────────────────────────────────────────────────

// The YAML in a reply: the first fenced block if there is one, else the whole reply.
export function yaml_of(reply: string): string {
  return reply.match(/```(?:ya?ml)?\s*\n([\s\S]*?)```/)?.[1] ?? reply;
}

// Puts the model's facts and rules in place of the reference's, keeps its relations and questions, and counts the answers the engine then gets right.
export function score_extraction(task: ExtractionTask, reply: string): ExtractionScore {
  const total = task.reference.cases.reduce((sum, entry) => sum + questions_of(entry).length, 0);
  const failed = (problem: string): ExtractionScore => ({ id: task.id, correct: 0, total, problem });

  let written: unknown;
  try {
    written = parse(yaml_of(reply));
  } catch (error) {
    return failed(`not valid YAML: ${(error as Error).message.split("\n")[0]}`);
  }
  if (typeof written !== "object" || written === null || Array.isArray(written)) return failed("the reply holds no facts and rules");
  const { facts, rules } = written as Record<string, unknown>;

  const document = parse(task.reference_yaml) as Record<string, unknown>;
  const relations = document.relations as Record<string, unknown>;
  if (!(guard_relation in relations)) relations[guard_relation] = guard_meaning;
  document.method = "llm_drafted";
  document.facts = facts ?? [];
  document.rules = rules;

  let rule_set: RuleSet;
  try {
    rule_set = parse_rule_set(stringify(document), task.id);
  } catch (error) {
    // parse_rule_set reports every problem it finds as a RuleSetError.
    return failed((error as RuleSetError).problems.slice(0, 2).join("; "));
  }
  // Loading already checked the questions' facts, so the engine runs them without a loop.
  const wrong = check_cases(rule_set).reduce((sum, result) => sum + result.wrong.length, 0);
  return { id: task.id, correct: total - wrong, total, problem: "" };
}
