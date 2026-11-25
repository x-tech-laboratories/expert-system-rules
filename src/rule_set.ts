// Reads a rule set from YAML and checks it: facts are subject-relation-object triples, rules join triples through ?variables, and nothing may depend on its own negation.
// A rule set may share a vocabulary of relations and import other rule sets' facts and rules; the loader finds both from the catalog at the repository root.

// ── Imports ──────────────────────────────────────────────────────────────────

import { access, readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { parse } from "yaml";

import { ground_layers, stratify } from "./layers.ts";
import {
  base_relation,
  constant_pattern,
  is_builtin,
  is_open,
  is_variable,
  methods,
  number_pattern,
  opposite,
  triple_text,
  variable_pattern,
  worlds,
  type Condition,
  type Relation,
  type Rule,
  type Triple,
  type World,
} from "./terms.ts";

export * from "./terms.ts";
export { ground_layers, stratify } from "./layers.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Case {
  id: string;
  note: string;
  facts: Triple[];
  expect: Triple[];
  expect_not: Triple[];
  expect_unknown: Triple[];
}

export interface RuleSet {
  id: string;
  title: string;
  description: string;
  version: string;
  license: string;
  source: string;
  method: string;
  world: World;
  tags: string[];
  origin: string;
  vocabularies: string[];
  imports: string[];
  relations: Map<string, Relation>;
  facts: Triple[];
  rules: Rule[];
  cases: Case[];
  // Layers by kind of triple, or null when the rules only settle triple by triple (see ground_layers).
  rule_strata: Map<string, number> | null;
}

export interface Vocabulary {
  id: string;
  title: string;
  version: string;
  license: string;
  source: string;
  relations: Map<string, Relation>;
}

// What a rule set can name: vocabularies by id, and other rule sets by their path under rulesets/ without ".yaml".
export interface Library {
  vocabulary(name: string): Vocabulary | undefined;
  rule_set(name: string): RuleSet | undefined;
}

export class RuleSetError extends Error {
  problems: string[];

  constructor(origin: string, problems: string[]) {
    super(`${origin}:\n  ${problems.join("\n  ")}`);
    this.name = "RuleSetError";
    this.problems = problems;
  }
}

const empty_library: Library = { vocabulary: () => undefined, rule_set: () => undefined };

// ── Terms and triples ────────────────────────────────────────────────────────

const version_pattern = /^\d+\.\d+\.\d+$/;
const wikidata_pattern = /^P[1-9]\d*$/;
const module_pattern = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

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
    const fits = constant_pattern.test(term) || number_pattern.test(term) || (options.variables && variable_pattern.test(term));
    if (!fits) problems.push(`${where}: "${term}" must be a lower_snake_case name or a number${options.variables ? " or a ?variable" : ""}`);
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

// A triple written with "not" in a fact or a conclusion is a denial.
const stated = (condition: Condition): Triple => (condition.negated ? opposite(condition) : plain(condition));

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

function read_text(mapping: Mapping, key: string, problems: string[], required = true, where = ""): string {
  const value = mapping[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === undefined && !required) return "";
  problems.push(`${where}"${key}" must be a non-empty string`);
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

function read_version(mapping: Mapping, problems: string[]): string {
  // YAML reads an unquoted 2.1 as a number; show it as written.
  const version = typeof mapping.version === "number" ? String(mapping.version) : read_text(mapping, "version", problems);
  if (version && !version_pattern.test(version)) problems.push(`"version" must be major.minor.patch, such as 1.0.0, not "${version}"`);
  return version;
}

function read_method(mapping: Mapping, where: string, fallback: string, problems: string[]): string {
  const method = read_text(mapping, "method", problems, false, where);
  if (method && !(methods as readonly string[]).includes(method)) problems.push(`${where}"method" must be one of ${methods.join(", ")}, not "${method}"`);
  return method || fallback;
}

function read_world<Fallback extends World | "">(mapping: Mapping, where: string, fallback: Fallback, problems: string[]): World | Fallback {
  const world = mapping.world;
  if (world === undefined) return fallback;
  if ((worlds as readonly unknown[]).includes(world)) return world as World;
  problems.push(`${where}"world" must be closed or open, not ${JSON.stringify(world)}`);
  return fallback;
}

function unknown_keys(mapping: Mapping, allowed: string[], where: string, problems: string[]): void {
  for (const key of Object.keys(mapping)) if (!allowed.includes(key)) problems.push(`${where} has an unknown field "${key}"; the fields are ${allowed.join(", ")}`);
}

// Reads relations written as "name: meaning" or "name: { meaning, wikidata }".
function read_relations(value: unknown, problems: string[]): Map<string, Relation> {
  const relations = new Map<string, Relation>();
  if (value === undefined) return relations;
  if (!is_mapping(value)) {
    problems.push(`"relations" must map each relation name to what it means`);
    return relations;
  }
  for (const [name, entry] of Object.entries(value)) {
    if (!constant_pattern.test(name)) problems.push(`relation "${name}" must be lower_snake_case`);
    if (is_builtin(name)) problems.push(`relation "${name}" is built in; remove it from "relations"`);
    const details = is_mapping(entry) ? entry : { meaning: entry };
    if (is_mapping(entry)) unknown_keys(entry, ["meaning", "wikidata", "world"], `relation "${name}"`, problems);
    const meaning = typeof details.meaning === "string" ? details.meaning.trim() : "";
    if (!meaning) problems.push(`relation "${name}" needs a meaning`);
    const wikidata = details.wikidata === undefined ? "" : String(details.wikidata).trim();
    if (details.wikidata !== undefined && !wikidata_pattern.test(wikidata)) problems.push(`relation "${name}": "wikidata" must be a property id such as P31, not "${wikidata}"`);
    const world = read_world(details, `relation "${name}": `, "", problems);
    relations.set(name, { meaning, wikidata, world, from: "" });
  }
  return relations;
}

function read_yaml(text: string, origin: string): Mapping {
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    throw new RuleSetError(origin, [`not valid YAML: ${(error as Error).message.split("\n")[0]}`]);
  }
  if (!is_mapping(document)) throw new RuleSetError(origin, ["the file must hold a mapping"]);
  return document;
}

// ── Vocabularies ─────────────────────────────────────────────────────────────

export function parse_vocabulary(text: string, origin: string): Vocabulary {
  const document = read_yaml(text, origin);
  const problems: string[] = [];
  unknown_keys(document, ["id", "title", "version", "license", "source", "relations"], "the vocabulary", problems);
  const id = read_text(document, "id", problems);
  const title = read_text(document, "title", problems);
  const version = read_version(document, problems);
  const license = read_text(document, "license", problems);
  const source = read_text(document, "source", problems);
  const relations = read_relations(document.relations, problems);
  if (!relations.size) problems.push(`"relations" must list at least one relation`);
  if (problems.length) throw new RuleSetError(origin, problems);
  for (const relation of relations.values()) relation.from = id;
  return { id, title, version, license, source, relations };
}

// Adds relations from a vocabulary or an import, refusing a name that already means something else.
function merge_relations(into: Map<string, Relation>, from: Map<string, Relation>, label: string, problems: string[]): void {
  for (const [name, relation] of from) {
    const existing = into.get(name);
    if (!existing) into.set(name, { ...relation, from: relation.from || label });
    else if (existing.from === "") problems.push(`the relation "${name}" is already defined by ${label}; remove it from "relations"`);
    else if (existing.meaning !== relation.meaning) problems.push(`the relation "${name}" means different things in ${existing.from} and ${label}`);
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const rule_set_fields = ["id", "title", "description", "version", "license", "source", "method", "world", "tags", "vocabularies", "imports", "relations", "facts", "rules", "cases"];
const rule_fields = ["id", "if", "then", "usually", "source", "method", "note"];
const case_fields = ["id", "note", "facts", "expect", "expect_not", "expect_unknown"];

export function parse_rule_set(text: string, origin: string, library: Library = empty_library): RuleSet {
  const document = read_yaml(text, origin);
  const problems: string[] = [];
  unknown_keys(document, rule_set_fields, "the rule set", problems);
  const id = read_text(document, "id", problems);
  const title = read_text(document, "title", problems);
  const description = read_text(document, "description", problems, false);
  const version = read_version(document, problems);
  const license = read_text(document, "license", problems);
  const source = read_text(document, "source", problems);
  const method = read_method(document, "", "hand_written", problems);
  const world = read_world(document, "", "closed", problems);
  const tags = read_names(document.tags, `"tags"`, problems);
  const vocabularies = read_names(document.vocabularies, `"vocabularies"`, problems);
  const imports = read_names(document.imports, `"imports"`, problems);

  const relations = read_relations(document.relations, problems);
  for (const name of vocabularies) {
    const vocabulary = library.vocabulary(name);
    if (!vocabulary) problems.push(`no vocabulary named "${name}"`);
    else merge_relations(relations, vocabulary.relations, `vocabulary ${name}`, problems);
  }

  const ground = { variables: false, negation: false };
  const facts = read_triples(document.facts, "fact", { variables: false, negation: true }, problems).map(stated);

  const rules: Rule[] = [];
  if (!Array.isArray(document.rules) || document.rules.length === 0) problems.push(`"rules" must be a non-empty list`);
  else {
    const seen = new Set<string>();
    document.rules.forEach((entry, index) => {
      if (!is_mapping(entry)) return void problems.push(`rule ${index + 1} must be a mapping with id, if and then`);
      const rule_id = typeof entry.id === "string" ? entry.id.trim() : "";
      const name = rule_id || String(index + 1);
      if (!rule_id) problems.push(`rule ${index + 1} needs an id`);
      else if (rule_id.includes(":")) problems.push(`rule id "${rule_id}" must not hold ":", which marks imported rules`);
      else if (seen.has(rule_id)) problems.push(`rule id "${rule_id}" is used twice`);
      seen.add(rule_id);
      unknown_keys(entry, rule_fields, `rule ${name}`, problems);

      const conditions = read_triples(entry.if, `rule ${name} condition`, { variables: true, negation: true }, problems);
      const has_conditions = Array.isArray(entry.if) && entry.if.length > 0;
      if (!has_conditions) problems.push(`rule ${name} needs a list of conditions under "if"`);
      const conclusion = read_triple(entry.then, `rule ${name} "then"`, { variables: true, negation: true }, problems);
      if (entry.usually !== undefined && typeof entry.usually !== "boolean") problems.push(`rule ${name}: "usually" must be true or false`);
      const rule_source = read_text(entry, "source", problems, false, `rule ${name}: `);
      const rule_method = read_method(entry, `rule ${name}: `, method, problems);
      const note = read_text(entry, "note", problems, false, `rule ${name}: `);
      if (!conclusion || !has_conditions) return;

      if (is_builtin(conclusion.relation)) problems.push(`rule ${name}: the comparison "${conclusion.relation}" can only be a condition`);
      const plain_conditions = conditions.filter(condition => !condition.negated && !is_builtin(condition.relation));
      const bound = new Set(plain_conditions.flatMap(condition => [condition.subject, condition.object]).filter(is_variable));
      const unbound = [conclusion, ...conditions.filter(condition => condition.negated || is_builtin(condition.relation))]
        .flatMap(triple => [triple.subject, triple.object])
        .filter(term => is_variable(term) && !bound.has(term));
      for (const variable of new Set(unbound)) problems.push(`rule ${name}: ${variable} must appear in a condition without "not" that is not a comparison`);
      rules.push({ id: rule_id, conditions, conclusion: stated(conclusion), usually: entry.usually === true, source: rule_source, method: rule_method, note, from: "" });
    });
  }

  // Imported facts and rules join this rule set's own; imported rule ids are qualified by where they came from.
  const imported_rules = new Map<string, Rule>();
  for (const name of imports) {
    if (!module_pattern.test(name)) problems.push(`the import "${name}" must be a path under rulesets/ without ".yaml", such as core/upper`);
    const other = library.rule_set(name);
    if (!other) {
      problems.push(`no rule set named "${name}" to import`);
      continue;
    }
    merge_relations(relations, other.relations, `import ${name}`, problems);
    facts.push(...other.facts);
    for (const rule of other.rules) {
      const qualified = rule.from ? rule : { ...rule, id: `${name}:${rule.id}`, from: name };
      imported_rules.set(qualified.id, qualified);
    }
  }
  rules.push(...imported_rules.values());

  const cases: Case[] = [];
  if (document.cases !== undefined && !Array.isArray(document.cases)) problems.push(`"cases" must be a list`);
  const seen_cases = new Set<string>();
  for (const [index, entry] of (Array.isArray(document.cases) ? document.cases : []).entries()) {
    if (!is_mapping(entry)) {
      problems.push(`case ${index + 1} must be a mapping with id and questions under expect, expect_not or expect_unknown`);
      continue;
    }
    const case_id = typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id).trim() : "";
    const name = case_id || String(index + 1);
    if (!case_id) problems.push(`case ${index + 1} needs an id`);
    else if (seen_cases.has(case_id)) problems.push(`case id "${case_id}" is used twice`);
    seen_cases.add(case_id);
    unknown_keys(entry, case_fields, `case ${name}`, problems);
    const case_facts = read_triples(entry.facts, `case ${name} fact`, { variables: false, negation: true }, problems).map(stated);
    const expect = read_triples(entry.expect, `case ${name} expect`, ground, problems).map(plain);
    const expect_not = read_triples(entry.expect_not, `case ${name} expect_not`, ground, problems).map(plain);
    const expect_unknown = read_triples(entry.expect_unknown, `case ${name} expect_unknown`, ground, problems).map(plain);
    const written = (value: unknown) => (Array.isArray(value) ? value.length : 0);
    if (written(entry.expect) + written(entry.expect_not) + written(entry.expect_unknown) === 0) problems.push(`case ${name} needs at least one question under expect, expect_not or expect_unknown`);
    cases.push({ id: case_id, note: typeof entry.note === "string" ? entry.note.trim() : "", facts: case_facts, expect, expect_not, expect_unknown });
  }

  const used = [...facts, ...rules.flatMap(rule => [rule.conclusion, ...rule.conditions]), ...cases.flatMap(entry => [...entry.facts, ...entry.expect, ...entry.expect_not, ...entry.expect_unknown])];
  for (const relation of new Set(used.map(triple => base_relation(triple.relation)))) {
    if (!relations.has(relation) && !is_builtin(relation)) problems.push(`the relation "${relation}" is used but not listed under "relations" or in a vocabulary`);
  }
  const stated_facts = [...facts, ...cases.flatMap(entry => [...entry.facts, ...entry.expect, ...entry.expect_not, ...entry.expect_unknown])];
  for (const relation of new Set(stated_facts.map(triple => base_relation(triple.relation)).filter(is_builtin))) {
    problems.push(`the comparison "${relation}" is worked out, not stated; it can only be a rule's condition`);
  }

  // "not" in a condition reads a closed world; in an open one, write the exception as a "not" conclusion and the rule with "usually".
  for (const rule of rules.filter(rule => !rule.from)) {
    for (const condition of rule.conditions.filter(condition => condition.negated && is_open({ world, relations }, condition.relation))) {
      problems.push(`rule ${rule.id}: "not ${triple_text(condition)}" reads the open-world relation "${condition.relation}", where a missing triple is unknown; conclude "not ..." in an exception and mark this rule "usually" instead`);
    }
  }

  // Layers by kind of triple when they exist; otherwise every case must settle triple by triple.
  const rule_strata = stratify(rules, [...facts, ...cases.flatMap(entry => entry.facts)]);
  if (!rule_strata && !problems.length) {
    const settings = cases.length ? cases.map(entry => ({ label: `in case ${entry.id}, `, facts: [...facts, ...entry.facts] })) : [{ label: "", facts }];
    for (const setting of settings) {
      const plan = ground_layers(rules, setting.facts);
      if (plan.loop) problems.push(`${setting.label}a conclusion depends on its own negation, so the rules have no single answer: ${plan.loop.join(", ")}`);
    }
  }

  if (problems.length) throw new RuleSetError(origin, problems);
  return { id, title, description, version, license, source, method, world, tags, origin, vocabularies, imports, relations, facts, rules, cases, rule_strata };
}

// ── Catalog ──────────────────────────────────────────────────────────────────

// The repository's map of rule sets: the subject folders under rulesets/ and the tags rule sets may carry.
export interface Subject {
  description: string;
  // The Wikidata item the subject covers, such as Q729 for animals, or "".
  wikidata: string;
}

export interface Catalog {
  root: string;
  subjects: Map<string, Subject>;
  tags: Map<string, string>;
}

const catalog_file = "catalog.yaml";

export function parse_catalog(text: string, root: string): Catalog {
  const origin = join(root, catalog_file);
  const document = read_yaml(text, origin);
  const problems: string[] = [];
  unknown_keys(document, ["subjects", "tags"], "the catalog", problems);
  const read_map = (key: string): Map<string, Mapping> => {
    const value = document[key];
    if (!is_mapping(value) || !Object.keys(value).length) {
      problems.push(`"${key}" must map each name to what it covers`);
      return new Map();
    }
    return new Map(Object.entries(value).map(([name, entry]) => [name, is_mapping(entry) ? entry : { description: entry }]));
  };
  const subjects = new Map<string, Subject>();
  for (const [name, entry] of read_map("subjects")) {
    unknown_keys(entry, ["description", "wikidata"], `subject "${name}"`, problems);
    const description = read_text(entry, "description", problems, true, `subject "${name}": `);
    const wikidata = entry.wikidata === undefined ? "" : String(entry.wikidata).trim();
    if (entry.wikidata !== undefined && !/^Q[1-9]\d*$/.test(wikidata)) problems.push(`subject "${name}": "wikidata" must be an item id such as Q729, not "${wikidata}"`);
    subjects.set(name, { description, wikidata });
  }
  const tags = new Map<string, string>();
  for (const [name, entry] of read_map("tags")) {
    unknown_keys(entry, ["description"], `tag "${name}"`, problems);
    tags.set(name, read_text(entry, "description", problems, true, `tag "${name}": `));
  }
  if (problems.length) throw new RuleSetError(origin, problems);
  return { root, subjects, tags };
}

// A rule set's name for imports: its path under rulesets/ without ".yaml", such as commonsense/kitchen.
export function module_name(catalog: Catalog, path: string): string {
  const inside = relative(join(catalog.root, "rulesets"), path);
  return inside.slice(0, inside.length - extname(inside).length).split(sep).join("/");
}

// Where a rule set file breaks the catalog: an unlisted subject folder or tag, or an id that is not the file name.
export function catalog_problems(catalog: Catalog, path: string, rule_set: RuleSet): string[] {
  const problems: string[] = [];
  const name = module_name(catalog, path);
  const subject = name.split("/")[0];
  if (name.startsWith("..") || !name.includes("/")) problems.push(`rule sets live in a subject folder under rulesets/, not at ${path}`);
  else if (!catalog.subjects.has(subject)) problems.push(`the subject folder "${subject}" is not listed under "subjects" in ${catalog_file}`);
  const stem = basename(path, extname(path));
  if (rule_set.id !== stem) problems.push(`the id "${rule_set.id}" must match the file name "${stem}"`);
  for (const tag of rule_set.tags) if (!catalog.tags.has(tag)) problems.push(`the tag "${tag}" is not listed under "tags" in ${catalog_file}`);
  return problems;
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Finds the catalog in the file's folder or the nearest folder above it.
export async function find_catalog(path: string): Promise<Catalog | null> {
  let folder = dirname(path);
  for (;;) {
    const candidate = join(folder, catalog_file);
    if (await exists(candidate)) return parse_catalog(await readFile(candidate, "utf8"), folder);
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}

// Loads vocabularies and imports from the files the catalog's root holds, each once, refusing imports that loop.
class FileLibrary implements Library {
  private vocabularies = new Map<string, Vocabulary>();
  private rule_sets = new Map<string, RuleSet>();
  private root: string | null;

  constructor(root: string | null) {
    this.root = root;
  }

  vocabulary(name: string): Vocabulary | undefined {
    return this.vocabularies.get(name);
  }

  rule_set(name: string): RuleSet | undefined {
    return this.rule_sets.get(name);
  }

  async load(path: string, loading: string[] = []): Promise<RuleSet> {
    const text = await readFile(path, "utf8");
    if (this.root) {
      let wanted: Mapping = {};
      try {
        wanted = read_yaml(text, path);
      } catch {
        // parse_rule_set reports the broken file below.
      }
      for (const name of read_names(wanted.vocabularies, "", [])) {
        const file = join(this.root, "vocabularies", `${name}.yaml`);
        if (!this.vocabularies.has(name) && (await exists(file))) this.vocabularies.set(name, parse_vocabulary(await readFile(file, "utf8"), file));
      }
      for (const name of read_names(wanted.imports, "", [])) {
        if (!module_pattern.test(name) || this.rule_sets.has(name)) continue;
        const file = join(this.root, "rulesets", `${name}.yaml`);
        if (loading.includes(file)) throw new RuleSetError(path, [`the imports loop: ${[...loading, file].map(item => relative(this.root!, item)).join(" -> ")}`]);
        if (await exists(file)) this.rule_sets.set(name, await this.load(file, [...loading, file]));
      }
    }
    return parse_rule_set(text, path, this);
  }
}

export async function load_rule_set(path: string): Promise<RuleSet> {
  const catalog = await find_catalog(path);
  return new FileLibrary(catalog?.root ?? null).load(path, [path]);
}

// Lists every .yaml file under a folder and its subject subfolders, in path order.
export async function list_rule_set_files(folder: string): Promise<string[]> {
  const names = await readdir(folder, { recursive: true });
  return names.filter(name => name.endsWith(".yaml") || name.endsWith(".yml")).map(name => join(folder, name)).sort();
}
