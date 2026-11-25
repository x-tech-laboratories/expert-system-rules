// Reads a rule set from YAML and checks it: every name known, every case consistent, and no conclusion that depends on its own negation.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Condition {
  fact: string;
  negated: boolean;
}

export interface Rule {
  id: string;
  conditions: Condition[];
  conclusion: string;
}

export interface Case {
  id: string;
  note: string;
  facts: string[];
  expect: string[];
}

export interface RuleSet {
  id: string;
  title: string;
  description: string;
  license: string;
  source: string;
  tags: string[];
  origin: string;
  features: Map<string, string>;
  goals: string[];
  rules: Rule[];
  cases: Case[];
  conclusions: string[];
  strata: Map<string, number>;
}

export class RuleSetError extends Error {
  problems: string[];

  constructor(origin: string, problems: string[]) {
    super(`${origin}:\n  ${problems.join("\n  ")}`);
    this.name = "RuleSetError";
    this.problems = problems;
  }
}

// ── Reading fields ───────────────────────────────────────────────────────────

const name_pattern = /^[a-z][a-z0-9_]*$/;
const negation_pattern = /^not\s+(\S+)$/;

type Record_ = Record<string, unknown>;

function is_record(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read_text(record: Record_, key: string, problems: string[], required = true): string {
  const value = record[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === undefined && !required) return "";
  problems.push(`"${key}" must be a non-empty string`);
  return "";
}

function read_names(value: unknown, where: string, problems: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    problems.push(`${where} must be a list of names`);
    return [];
  }
  return value.map(item => String(item).trim());
}

function read_condition(text: string): Condition {
  const negation = negation_pattern.exec(text);
  return negation ? { fact: negation[1], negated: true } : { fact: text, negated: false };
}

// ── Stratifying ──────────────────────────────────────────────────────────────

// Gives each conclusion a layer above everything it depends on, and a layer strictly above anything it negates; null when a negation loops back on itself.
export function stratify(rules: Rule[], features: Map<string, string>): Map<string, number> | null {
  const strata = new Map(rules.map(rule => [rule.conclusion, 0]));
  for (let round = 0; round <= strata.size; round++) {
    let changed = false;
    for (const rule of rules) {
      for (const condition of rule.conditions) {
        if (features.has(condition.fact)) continue;
        const needed = (strata.get(condition.fact) ?? 0) + (condition.negated ? 1 : 0);
        if (needed > (strata.get(rule.conclusion) ?? 0)) {
          strata.set(rule.conclusion, needed);
          changed = true;
        }
      }
    }
    if (!changed) return strata;
  }
  return null;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parse_rule_set(text: string, origin: string): RuleSet {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    throw new RuleSetError(origin, [`not valid YAML: ${(error as Error).message.split("\n")[0]}`]);
  }
  if (!is_record(document)) throw new RuleSetError(origin, ["the file must hold a mapping"]);

  const problems: string[] = [];
  const id = read_text(document, "id", problems);
  const title = read_text(document, "title", problems);
  const description = read_text(document, "description", problems, false);
  const license = read_text(document, "license", problems);
  const source = read_text(document, "source", problems);
  const tags = read_names(document.tags, `"tags"`, problems);

  const features = new Map<string, string>();
  if (!is_record(document.features)) problems.push(`"features" must map each feature name to its question`);
  else {
    for (const [name, question] of Object.entries(document.features)) {
      if (!name_pattern.test(name)) problems.push(`feature "${name}" must be lower_snake_case`);
      if (typeof question !== "string" || !question.trim()) problems.push(`feature "${name}" needs a question`);
      features.set(name, String(question ?? "").trim());
    }
  }

  const rules: Rule[] = [];
  if (!Array.isArray(document.rules) || document.rules.length === 0) problems.push(`"rules" must be a non-empty list`);
  else {
    const seen = new Set<string>();
    document.rules.forEach((entry, index) => {
      const where = `rule ${index + 1}`;
      if (!is_record(entry)) return void problems.push(`${where} must be a mapping with id, if and then`);
      const rule_id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!rule_id) problems.push(`${where} needs an id`);
      else if (seen.has(rule_id)) problems.push(`rule id "${rule_id}" is used twice`);
      seen.add(rule_id);
      const conditions = read_names(entry.if, `rule ${rule_id || index + 1} "if"`, problems).map(read_condition);
      if (conditions.length === 0) problems.push(`rule ${rule_id || index + 1} needs at least one condition`);
      const conclusion = typeof entry.then === "string" ? entry.then.trim() : "";
      if (!name_pattern.test(conclusion)) problems.push(`rule ${rule_id || index + 1} "then" must be one lower_snake_case name`);
      if (features.has(conclusion)) problems.push(`rule ${rule_id} concludes "${conclusion}", which is a feature; features are only ever given`);
      rules.push({ id: rule_id, conditions, conclusion });
    });
  }

  const conclusions = [...new Set(rules.map(rule => rule.conclusion))].sort();
  const known = (name: string) => features.has(name) || conclusions.includes(name);
  for (const rule of rules) {
    for (const condition of rule.conditions) {
      if (!known(condition.fact)) problems.push(`rule ${rule.id} uses "${condition.fact}", which is neither a feature nor a conclusion`);
    }
  }

  const goals = read_names(document.goals, `"goals"`, problems);
  for (const goal of goals) if (!conclusions.includes(goal)) problems.push(`goal "${goal}" is not concluded by any rule`);

  const cases: Case[] = [];
  if (document.cases !== undefined && !Array.isArray(document.cases)) problems.push(`"cases" must be a list`);
  const seen_cases = new Set<string>();
  for (const [index, entry] of (Array.isArray(document.cases) ? document.cases : []).entries()) {
    if (!is_record(entry)) {
      problems.push(`case ${index + 1} must be a mapping with id, facts and expect`);
      continue;
    }
    const case_id = typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id).trim() : "";
    if (!case_id) problems.push(`case ${index + 1} needs an id`);
    else if (seen_cases.has(case_id)) problems.push(`case id "${case_id}" is used twice`);
    seen_cases.add(case_id);
    const facts = read_names(entry.facts, `case ${case_id} "facts"`, problems);
    const expect = read_names(entry.expect, `case ${case_id} "expect"`, problems);
    for (const fact of facts) if (!features.has(fact)) problems.push(`case ${case_id} gives "${fact}", which is not a feature`);
    for (const fact of expect) if (!conclusions.includes(fact)) problems.push(`case ${case_id} expects "${fact}", which no rule concludes`);
    cases.push({ id: case_id, note: typeof entry.note === "string" ? entry.note.trim() : "", facts, expect });
  }

  const strata = stratify(rules, features);
  if (!strata) problems.push("a conclusion depends on its own negation, so the rules have no single answer");

  if (problems.length) throw new RuleSetError(origin, problems);
  return { id, title, description, license, source, tags, origin, features, goals, rules, cases, conclusions, strata: strata! };
}

// ── Loading ──────────────────────────────────────────────────────────────────

export async function load_rule_set(path: string): Promise<RuleSet> {
  return parse_rule_set(await readFile(path, "utf8"), path);
}

// Lists every .yaml file under a folder and its subject subfolders, in path order.
export async function list_rule_set_files(folder: string): Promise<string[]> {
  const names = await readdir(folder, { recursive: true });
  return names.filter(name => name.endsWith(".yaml") || name.endsWith(".yml")).map(name => join(folder, name)).sort();
}
