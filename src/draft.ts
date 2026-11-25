// Asks a model to draft a rule set from a source text, and checks the draft the way a reviewer would before reading it:
// it must load, fit the catalog, agree with its own cases, and quote the source word for word for every rule.

// ── Imports ──────────────────────────────────────────────────────────────────

import { catalog_problems, load_rule_set_text, RuleSetError, triple_text, type Catalog, type RuleSet, type Vocabulary } from "./rule_set.ts";
import { check_cases } from "./runner.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface DraftRequest {
  source_text: string;
  id: string;
  subject: string;
  license: string;
  // How the rule set's `source` field must credit the text.
  cite: string;
}

export interface DraftCheck {
  rule_set: RuleSet | null;
  problems: string[];
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export function draft_prompt(request: DraftRequest, catalog: Catalog, core: Vocabulary | undefined, previous?: { yaml: string; problems: string[] }): string {
  const lines = [
    "Draft a rule set for a rule engine from the source text below. Use ONLY what the text states; add no outside knowledge.",
    "",
    "Source text:",
    "<<<",
    request.source_text.trim(),
    ">>>",
    "",
    "The rule set is one YAML file with these fields:",
    `  id: ${request.id}`,
    "  title: a short human name",
    "  description: what the rule set covers, in a sentence or two",
    "  version: 1.0.0",
    `  license: ${request.license}`,
    `  source: ${JSON.stringify(request.cite)}`,
    "  method: llm_drafted",
    `  tags: a few of: ${[...catalog.tags.keys()].join(", ")}`,
    ...(core ? ["  vocabularies: [core]"] : []),
    "  relations: each relation you add, with what it means (not the shared ones below)",
    "  facts: triples that always hold, if the text states any",
    "  rules: the rules",
    "  cases: test cases",
    "",
    ...(core ? [`Shared relations you may use without listing them: ${[...core.relations].map(([name, relation]) => `${name} (${relation.meaning})`).join("; ")}.`, ""] : []),
    'Every statement is a triple "subject relation object" of lower_snake_case names or numbers, such as "raw_chicken is_a poultry" or "oven temperature_c 180".',
    "A rule is { id: R1, if: [conditions], then: conclusion, source: \"...\" }. Words starting with ? are variables.",
    "- `source` on every rule is a quote copied word for word from the source text that states the rule. Rules the text does not state are not allowed.",
    '- A condition starting with "not" holds when its triple cannot be concluded. Every variable in a "not" condition or in the conclusion must also appear in a plain condition.',
    '- "then: not X" says X is false. "usually: true" marks a rule that holds unless something concludes "not" its conclusion; use it for rules the text says have exceptions.',
    "- less_than, greater_than, at_most, at_least and equal_to compare two numbers in conditions; both sides must come from other conditions.",
    "",
    "Cases test the rules: each has an id, an optional note, facts, and the triples that must hold (expect) or must not (expect_not).",
    "Write at least four cases covering every rule, including cases near a threshold and cases where an exception applies.",
    "Each case's answers must follow from the rules exactly; a rule engine checks them.",
    "",
    "Answer with the YAML file only.",
  ];
  if (previous) {
    lines.push("", "Your previous draft was refused for these problems:", ...previous.problems.map(problem => `- ${problem}`), "", "Previous draft:", previous.yaml, "", "Fix every problem and answer with the whole corrected YAML file only.");
  }
  return lines.join("\n");
}

// ── Checking ─────────────────────────────────────────────────────────────────

function normalise(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}

// Every rule of the draft's own must quote the source text exactly (ignoring case, curly quotes and spacing).
export function quote_problems(rule_set: RuleSet, source_text: string): string[] {
  const source = normalise(source_text);
  return rule_set.rules
    .filter(rule => !rule.from)
    .flatMap(rule => {
      if (!rule.source) return [`rule ${rule.id} needs "source": a quote from the text that states it`];
      return source.includes(normalise(rule.source)) ? [] : [`rule ${rule.id}: the quote "${rule.source}" is not in the source text word for word`];
    });
}

// Loads a draft as if saved at path and lists everything a reviewer would have to send back.
export async function check_draft(text: string, path: string, request: DraftRequest, catalog: Catalog): Promise<DraftCheck> {
  let rule_set: RuleSet;
  try {
    rule_set = await load_rule_set_text(text, path);
  } catch (error) {
    if (error instanceof RuleSetError) return { rule_set: null, problems: error.problems };
    return { rule_set: null, problems: [(error as Error).message] };
  }
  const problems = [...catalog_problems(catalog, path, rule_set), ...quote_problems(rule_set, request.source_text)];
  if (rule_set.license !== request.license) problems.push(`"license" must be ${request.license}`);
  if (rule_set.method !== "llm_drafted") problems.push(`"method" must be llm_drafted`);
  if (rule_set.cases.length < 4) problems.push("write at least four cases");
  const untested = rule_set.rules.filter(rule => !rule.from && !rule_set.cases.some(entry => [...entry.expect, ...entry.expect_not].some(triple => triple.relation === rule.conclusion.relation.replace(/^!/, ""))));
  for (const rule of untested) problems.push(`no case asks about "${rule.conclusion.relation.replace(/^!/, "")}", which rule ${rule.id} concludes`);
  for (const result of check_cases(rule_set)) {
    for (const wrong of result.wrong) problems.push(`case ${result.id}: "${triple_text(wrong.triple)}" is ${String(wrong.expected)} by the rules, but the case says ${String(wrong.got)}`);
    for (const conflict of result.conflicts) problems.push(`case ${result.id}: "${triple_text(conflict)}" is concluded both to hold and to be false`);
  }
  return { rule_set: problems.length ? null : rule_set, problems };
}
