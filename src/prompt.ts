// Turns a rule set into one plain-English prompt for an AI model, and reads the model's JSON answer back.

// ── Imports ──────────────────────────────────────────────────────────────────

import { condition_text } from "./engine.ts";
import type { Condition, RuleSet } from "./rule_set.ts";

// ── Prompt ───────────────────────────────────────────────────────────────────

function condition_english(condition: Condition): string {
  return condition.negated ? `it is NOT ${condition.fact}` : `it is ${condition.fact}`;
}

export function build_prompt(rule_set: RuleSet): string {
  return [
    `You are given a closed set of rules (${rule_set.title}). Use ONLY these rules, not real-world knowledge.`,
    "Each case has exactly the listed starting facts and nothing else. A rule fires when all its conditions hold.",
    "'NOT x' means x cannot be concluded from the facts and rules at all (closed-world assumption).",
    "",
    "Rules:",
    ...rule_set.rules.map(rule => `  ${rule.id}: IF ${rule.conditions.map(condition_english).join(" AND ")} THEN it is ${rule.conclusion}`),
    "",
    "Cases:",
    ...rule_set.cases.map(entry => `  ${entry.id}: ${entry.facts.join(", ") || "(no facts)"}`),
    "",
    `For each case, list every conclusion it gets from this set: ${rule_set.conclusions.join(", ")}.`,
    'Answer with JSON only, shaped {"case id": ["conclusion", ...], ...}.',
  ].join("\n");
}

// The rules as compact lines, as the explain command prints them.
export function rules_listing(rule_set: RuleSet): string[] {
  return rule_set.rules.map(rule => `${rule.id}: IF ${rule.conditions.map(condition_text).join(" AND ")} THEN ${rule.conclusion}`);
}

// ── Answer ───────────────────────────────────────────────────────────────────

// Reads the first JSON object in a model's reply, skipping any prose or code fence around it.
export function parse_answer(text: string): Map<string, string[]> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the answer holds no JSON object");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("the answer is not a JSON object");
  const answers = new Map<string, string[]>();
  for (const [key, list] of Object.entries(value)) answers.set(key, Array.isArray(list) ? list.map(String) : []);
  return answers;
}
