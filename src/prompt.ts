// Turns a rule set into one plain-English prompt for an AI model, and reads the model's JSON answer back.

// ── Imports ──────────────────────────────────────────────────────────────────

import { rule_text, triple_text, type Case, type RuleSet, type Triple } from "./rule_set.ts";

// ── Questions ────────────────────────────────────────────────────────────────

export interface Question {
  triple: Triple;
  answer: boolean;
}

// A case's questions in order: first those whose answer is true, then those whose answer is false.
export function questions_of(entry: Case): Question[] {
  return [...entry.expect.map(triple => ({ triple, answer: true })), ...entry.expect_not.map(triple => ({ triple, answer: false }))];
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function build_prompt(rule_set: RuleSet): string {
  const relations = [...rule_set.relations].map(([name, meaning]) => `  ${name}: ${meaning}`);
  return [
    `You are given a closed set of facts and rules (${rule_set.title}). Use ONLY these, not real-world knowledge.`,
    `Facts are written "subject relation object". Words starting with ? are variables: a rule applies to every way of filling them in that makes all its conditions true, and then its conclusion is a fact too.`,
    "'NOT x' means x cannot be concluded from the facts and rules at all (closed-world assumption).",
    ...(relations.length ? ["", "Relations:", ...relations] : []),
    "",
    "Rules:",
    ...rule_set.rules.map(rule => `  ${rule_text(rule)}`),
    ...(rule_set.facts.length ? ["", "Facts that hold in every case:", ...rule_set.facts.map(fact => `  ${triple_text(fact)}`)] : []),
    "",
    "Cases. Each case adds its own facts to the shared ones; cases are independent of each other.",
    ...rule_set.cases.flatMap(entry => [
      `  ${entry.id}: facts: ${entry.facts.map(triple_text).join("; ") || "(none)"}`,
      ...questions_of(entry).map((question, index) => `    question ${index + 1}: does "${triple_text(question.triple)}" hold?`),
    ]),
    "",
    "Answer every question with true or false.",
    'Answer with JSON only, shaped {"case id": [true, false, ...], ...}, one list per case with the answers in question order.',
  ].join("\n");
}

// ── Answer ───────────────────────────────────────────────────────────────────

function as_boolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|yes)$/i.test(value.trim())) return true;
  if (typeof value === "string" && /^(false|no)$/i.test(value.trim())) return false;
  return null;
}

// Reads the first JSON object in a model's reply, skipping any prose or code fence around it; an answer that is not true or false reads as null.
export function parse_answer(text: string): Map<string, (boolean | null)[]> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the answer holds no JSON object");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the answer is not a JSON object");
  const answers = new Map<string, (boolean | null)[]>();
  for (const [key, list] of Object.entries(value)) answers.set(key, Array.isArray(list) ? list.map(as_boolean) : []);
  return answers;
}
