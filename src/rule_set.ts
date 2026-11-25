// Reads a rule set from YAML and checks it: facts are subject-relation-object triples, rules join triples through ?variables, and nothing may depend on its own negation.

// ── Imports ──────────────────────────────────────────────────────────────────

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Triple {
  subject: string;
  relation: string;
  object: string;
}

export interface Condition extends Triple {
  negated: boolean;
}

export interface Rule {
  id: string;
  conditions: Condition[];
  conclusion: Triple;
}

export interface Case {
  id: string;
  note: string;
  facts: Triple[];
  expect: Triple[];
  expect_not: Triple[];
}

export interface RuleSet {
  id: string;
  title: string;
  description: string;
  license: string;
  source: string;
  tags: string[];
  origin: string;
  relations: Map<string, string>;
  facts: Triple[];
  rules: Rule[];
  cases: Case[];
  rule_strata: Map<string, number>;
}

export class RuleSetError extends Error {
  problems: string[];

  constructor(origin: string, problems: string[]) {
    super(`${origin}:\n  ${problems.join("\n  ")}`);
    this.name = "RuleSetError";
    this.problems = problems;
  }
}

// ── Terms and triples ────────────────────────────────────────────────────────

const constant_pattern = /^[a-z0-9][a-z0-9_]*$/;
const variable_pattern = /^\?[a-z][a-z0-9_]*$/;

export function is_variable(term: string): boolean {
  return term.startsWith("?");
}

export function triple_text(triple: Triple): string {
  return `${triple.subject} ${triple.relation} ${triple.object}`;
}

export function condition_text(condition: Condition): string {
  return (condition.negated ? "NOT " : "") + triple_text(condition);
}

export function rule_text(rule: Rule): string {
  return `${rule.id}: IF ${rule.conditions.map(condition_text).join(" AND ")} THEN ${triple_text(rule.conclusion)}`;
}

interface TripleOptions {
  variables: boolean;
  negation: boolean;
}

// Reads "subject relation object", or "not subject relation object" where negation is allowed.
function read_triple(value: unknown, where: string, options: TripleOptions, problems: string[]): Condition | null {
  const words = typeof value === "string" ? value.trim().split(/\s+/) : [];
  const negated = options.negation && words.length === 4 && words[0] === "not";
  const parts = negated ? words.slice(1) : words;
  if (parts.length !== 3) {
    problems.push(`${where} must be "subject relation object"${options.negation ? ', optionally after "not"' : ""}, not ${JSON.stringify(value)}`);
    return null;
  }
  const [subject, relation, object] = parts;
  for (const term of [subject, object]) {
    const fits = constant_pattern.test(term) || (options.variables && variable_pattern.test(term));
    if (!fits) problems.push(`${where}: "${term}" must be a lower_snake_case name${options.variables ? " or a ?variable" : ""}`);
  }
  if (!constant_pattern.test(relation)) problems.push(`${where}: the relation "${relation}" must be a lower_snake_case name`);
  return { subject, relation, object, negated };
}

function read_triples(value: unknown, where: string, options: TripleOptions, problems: string[]): Condition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list`);
    return [];
  }
  return value.flatMap((item, index) => read_triple(item, `${where} ${index + 1}`, options, problems) ?? []);
}

const plain = ({ subject, relation, object }: Triple): Triple => ({ subject, relation, object });

// Reads one triple typed by a person, such as a question on the command line; a ?variable is allowed.
export function parse_triple(text: string): Triple {
  const problems: string[] = [];
  const triple = read_triple(text, "the triple", { variables: true, negation: false }, problems);
  if (!triple || problems.length) throw new Error(problems.join("; "));
  return plain(triple);
}

// ── Reading fields ───────────────────────────────────────────────────────────

type Mapping = Record<string, unknown>;

function is_mapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read_text(mapping: Mapping, key: string, problems: string[], required = true): string {
  const value = mapping[key];
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

// ── Layers ───────────────────────────────────────────────────────────────────

// A triple's kind for layering: its relation, with its subject and object when they are fixed.
function signature(triple: Triple): string {
  const fixed = (term: string) => (is_variable(term) ? "*" : term);
  return `${fixed(triple.subject)} ${triple.relation} ${fixed(triple.object)}`;
}

function signatures_overlap(first: string, second: string): boolean {
  const first_parts = first.split(" ");
  const second_parts = second.split(" ");
  return first_parts.every((part, index) => part === second_parts[index] || ((index === 0 || index === 2) && (part === "*" || second_parts[index] === "*")));
}

// Puts every rule in a layer that runs after everything its conditions read, and strictly after anything it negates; null when a negation loops back on itself.
export function stratify(rules: Rule[], given: Triple[]): Map<string, number> | null {
  const kinds = [...new Set([...given, ...rules.flatMap(rule => [rule.conclusion, ...rule.conditions])].map(signature))];
  const layer = new Map(kinds.map(kind => [kind, 0]));
  const overlapping = (kind: string) => kinds.filter(other => signatures_overlap(kind, other));

  let settled = false;
  for (let round = 0; round <= kinds.length && !settled; round++) {
    settled = true;
    for (const rule of rules) {
      const heads = overlapping(signature(rule.conclusion));
      for (const condition of rule.conditions) {
        for (const read of overlapping(signature(condition))) {
          const needed = layer.get(read)! + (condition.negated ? 1 : 0);
          for (const head of heads) {
            if (needed > layer.get(head)!) {
              layer.set(head, needed);
              settled = false;
            }
          }
        }
      }
    }
  }
  if (!settled) return null;

  const rule_strata = new Map<string, number>();
  for (const rule of rules) {
    const needs = rule.conditions.flatMap(condition => overlapping(signature(condition)).map(read => layer.get(read)! + (condition.negated ? 1 : 0)));
    rule_strata.set(rule.id, Math.max(0, ...needs));
  }
  return rule_strata;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export function parse_rule_set(text: string, origin: string): RuleSet {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    throw new RuleSetError(origin, [`not valid YAML: ${(error as Error).message.split("\n")[0]}`]);
  }
  if (!is_mapping(document)) throw new RuleSetError(origin, ["the file must hold a mapping"]);

  const problems: string[] = [];
  const id = read_text(document, "id", problems);
  const title = read_text(document, "title", problems);
  const description = read_text(document, "description", problems, false);
  const license = read_text(document, "license", problems);
  const source = read_text(document, "source", problems);
  const tags = read_names(document.tags, `"tags"`, problems);

  const relations = new Map<string, string>();
  if (!is_mapping(document.relations)) problems.push(`"relations" must map each relation name to what it means`);
  else {
    for (const [name, meaning] of Object.entries(document.relations)) {
      if (!constant_pattern.test(name)) problems.push(`relation "${name}" must be lower_snake_case`);
      if (typeof meaning !== "string" || !meaning.trim()) problems.push(`relation "${name}" needs a meaning`);
      relations.set(name, String(meaning ?? "").trim());
    }
  }

  const ground = { variables: false, negation: false };
  const facts = read_triples(document.facts, "fact", ground, problems).map(plain);

  const rules: Rule[] = [];
  if (!Array.isArray(document.rules) || document.rules.length === 0) problems.push(`"rules" must be a non-empty list`);
  else {
    const seen = new Set<string>();
    document.rules.forEach((entry, index) => {
      if (!is_mapping(entry)) return void problems.push(`rule ${index + 1} must be a mapping with id, if and then`);
      const rule_id = typeof entry.id === "string" ? entry.id.trim() : "";
      const name = rule_id || String(index + 1);
      if (!rule_id) problems.push(`rule ${index + 1} needs an id`);
      else if (seen.has(rule_id)) problems.push(`rule id "${rule_id}" is used twice`);
      seen.add(rule_id);

      const conditions = read_triples(entry.if, `rule ${name} condition`, { variables: true, negation: true }, problems);
      const has_conditions = Array.isArray(entry.if) && entry.if.length > 0;
      if (!has_conditions) problems.push(`rule ${name} needs a list of conditions under "if"`);
      const conclusion = read_triple(entry.then, `rule ${name} "then"`, { variables: true, negation: false }, problems);
      if (!conclusion || !has_conditions) return;

      const bound = new Set(conditions.filter(condition => !condition.negated).flatMap(condition => [condition.subject, condition.object]).filter(is_variable));
      const unbound = [conclusion, ...conditions.filter(condition => condition.negated)]
        .flatMap(triple => [triple.subject, triple.object])
        .filter(term => is_variable(term) && !bound.has(term));
      for (const variable of new Set(unbound)) problems.push(`rule ${name}: ${variable} must appear in a condition without "not"`);
      rules.push({ id: rule_id, conditions, conclusion: plain(conclusion) });
    });
  }

  const cases: Case[] = [];
  if (document.cases !== undefined && !Array.isArray(document.cases)) problems.push(`"cases" must be a list`);
  const seen_cases = new Set<string>();
  for (const [index, entry] of (Array.isArray(document.cases) ? document.cases : []).entries()) {
    if (!is_mapping(entry)) {
      problems.push(`case ${index + 1} must be a mapping with id and questions under expect or expect_not`);
      continue;
    }
    const case_id = typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id).trim() : "";
    const name = case_id || String(index + 1);
    if (!case_id) problems.push(`case ${index + 1} needs an id`);
    else if (seen_cases.has(case_id)) problems.push(`case id "${case_id}" is used twice`);
    seen_cases.add(case_id);
    const case_facts = read_triples(entry.facts, `case ${name} fact`, ground, problems).map(plain);
    const expect = read_triples(entry.expect, `case ${name} expect`, ground, problems).map(plain);
    const expect_not = read_triples(entry.expect_not, `case ${name} expect_not`, ground, problems).map(plain);
    const written = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    if (written(entry.expect) + written(entry.expect_not) === 0) problems.push(`case ${name} needs at least one question under expect or expect_not`);
    cases.push({ id: case_id, note: typeof entry.note === "string" ? entry.note.trim() : "", facts: case_facts, expect, expect_not });
  }

  const used = [...facts, ...rules.flatMap(rule => [rule.conclusion, ...rule.conditions]), ...cases.flatMap(entry => [...entry.facts, ...entry.expect, ...entry.expect_not])];
  for (const relation of new Set(used.map(triple => triple.relation))) {
    if (relations.size && !relations.has(relation)) problems.push(`the relation "${relation}" is used but not listed under "relations"`);
  }

  const rule_strata = stratify(rules, [...facts, ...cases.flatMap(entry => entry.facts)]);
  if (!rule_strata) problems.push("a conclusion depends on its own negation, so the rules have no single answer");

  if (problems.length) throw new RuleSetError(origin, problems);
  return { id, title, description, license, source, tags, origin, relations, facts, rules, cases, rule_strata: rule_strata! };
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
