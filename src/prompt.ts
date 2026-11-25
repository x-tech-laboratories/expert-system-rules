// Turns a rule set into one plain-English prompt for an AI model, and reads the model's JSON answer back.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Answer } from "./engine.ts";
import { builtins, is_builtin, is_denial, rule_text, triple_text, type Case, type RuleSet, type Triple } from "./rule_set.ts";

// ── Questions ────────────────────────────────────────────────────────────────

export interface Question {
  triple: Triple;
  answer: Answer;
}

// A case's questions in order: those whose answer is true, then false, then unknown.
export function questions_of(entry: Case): Question[] {
  return [
    ...entry.expect.map(triple => ({ triple, answer: true as Answer })),
    ...entry.expect_not.map(triple => ({ triple, answer: false as Answer })),
    ...entry.expect_unknown.map(triple => ({ triple, answer: "unknown" as Answer })),
  ];
}

// Whether any relation is open-world, so that "unknown" is a possible answer.
export function has_open_world(rule_set: RuleSet): boolean {
  return rule_set.world === "open" || [...rule_set.relations.values()].some(relation => relation.world === "open");
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function build_prompt(rule_set: RuleSet): string {
  const open = has_open_world(rule_set);
  const open_names = [...rule_set.relations].filter(([, relation]) => (relation.world || rule_set.world) === "open").map(([name]) => name);
  const relations = [...rule_set.relations].map(([name, relation]) => `  ${name}: ${relation.meaning}`);
  const defaults = rule_set.rules.some(rule => rule.usually) || [...rule_set.facts, ...rule_set.rules.map(rule => rule.conclusion)].some(is_denial);
  return [
    `You are given a closed set of facts and rules (${rule_set.title}). Use ONLY these, not real-world knowledge.`,
    `Facts are written "subject relation object". Words starting with ? are variables: a rule applies to every way of filling them in that makes all its conditions true, and then its conclusion is a fact too.`,
    "'NOT x' in a condition means x cannot be concluded from the facts and rules at all (closed-world assumption).",
    ...(defaults
      ? [
          "'not x' as a fact, or 'THEN NOT x' as a conclusion, means x is false.",
          "'THEN USUALLY x' is a default: x follows unless 'not x' is concluded; then x does not hold.",
        ]
      : []),
    ...(rule_set.rules.some(rule => rule.conditions.some(condition => is_builtin(condition.relation)))
      ? [`${[...builtins.keys()].join(", ")} compare two numbers, and are true or false by arithmetic alone.`]
      : []),
    ...(open
      ? [
          `These relations are open-world: ${open_names.join(", ")}. For them, a triple that is neither concluded nor concluded false is unknown, and NOT may not be used on them.`,
        ]
      : []),
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
    open ? 'Answer every question with true, false or "unknown".' : "Answer every question with true or false.",
    `Answer with JSON only, shaped {"case id": [true, false${open ? ', "unknown"' : ""}, ...], ...}, one list per case with the answers in question order.`,
  ].join("\n");
}

// ── Answer ───────────────────────────────────────────────────────────────────

function as_answer(value: unknown): Answer | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^unknown$/i.test(value.trim())) return "unknown";
  if (typeof value === "string" && /^(true|yes)$/i.test(value.trim())) return true;
  if (typeof value === "string" && /^(false|no)$/i.test(value.trim())) return false;
  return null;
}

// Reads the first JSON object in a model's reply, skipping any prose or code fence around it; an answer that is not true, false or unknown reads as null.
export function parse_answer(text: string): Map<string, (Answer | null)[]> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the answer holds no JSON object");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the answer is not a JSON object");
  const answers = new Map<string, (Answer | null)[]>();
  for (const [key, list] of Object.entries(value)) answers.set(key, Array.isArray(list) ? list.map(as_answer) : []);
  return answers;
}
