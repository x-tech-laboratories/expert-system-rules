// Triples, conditions and rules, the denial of a triple, the built-in comparisons of numbers, and filling variables in.

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Triple {
  subject: string;
  relation: string;
  object: string;
}

export interface Condition extends Triple {
  negated: boolean;
}

// How a rule came to be: written by a person, drafted by a model (and maybe reviewed), or converted mechanically from another collection.
export const methods = ["hand_written", "llm_drafted", "llm_drafted_human_reviewed", "converted"] as const;

export interface Rule {
  id: string;
  conditions: Condition[];
  // A denial (see opposite) when the rule concludes that something is false.
  conclusion: Triple;
  // A default: the conclusion holds unless the opposite is concluded.
  usually: boolean;
  source: string;
  method: string;
  note: string;
  // The rule set it was imported from, or "" for the rule set's own rules.
  from: string;
}

// Closed: what is not concluded is false. Open: what is not concluded is unknown.
export type World = "closed" | "open";
export const worlds: readonly World[] = ["closed", "open"];

export interface Relation {
  meaning: string;
  wikidata: string;
  // "" when the relation takes the rule set's world.
  world: World | "";
  // The vocabulary or imported rule set it comes from, or "" when the rule set declares it.
  from: string;
}

export type Bindings = Record<string, string>;

// ── Terms ────────────────────────────────────────────────────────────────────

export const constant_pattern = /^[a-z0-9][a-z0-9_]*$/;
export const number_pattern = /^-?\d+(\.\d+)?$/;
export const variable_pattern = /^\?[a-z][a-z0-9_]*$/;

export function is_variable(term: string): boolean {
  return term.startsWith("?");
}

export function is_ground(triple: Triple): boolean {
  return !is_variable(triple.subject) && !is_variable(triple.object);
}

// ── Denials ──────────────────────────────────────────────────────────────────

// A denial says a triple is false; it is kept as the same triple under the relation's name marked with "!".
const denial_mark = "!";

export function is_denial(triple: Triple): boolean {
  return triple.relation.startsWith(denial_mark);
}

export function base_relation(relation: string): string {
  return relation.startsWith(denial_mark) ? relation.slice(denial_mark.length) : relation;
}

// The triple saying the opposite: the denial of a triple, or the triple a denial denies.
export function opposite(triple: Triple): Triple {
  const relation = is_denial(triple) ? base_relation(triple.relation) : denial_mark + triple.relation;
  return { subject: triple.subject, relation, object: triple.object };
}

// ── Built-in comparisons ─────────────────────────────────────────────────────

// Relations every rule set has, comparing two numbers; they can only be conditions, and both sides must be filled in first.
export const builtins: ReadonlyMap<string, { meaning: string; test: (left: number, right: number) => boolean }> = new Map([
  ["less_than", { meaning: "The subject number is smaller than the object number.", test: (left: number, right: number) => left < right }],
  ["greater_than", { meaning: "The subject number is larger than the object number.", test: (left: number, right: number) => left > right }],
  ["at_most", { meaning: "The subject number is no larger than the object number.", test: (left: number, right: number) => left <= right }],
  ["at_least", { meaning: "The subject number is no smaller than the object number.", test: (left: number, right: number) => left >= right }],
  ["equal_to", { meaning: "The subject number is the same as the object number.", test: (left: number, right: number) => left === right }],
]);

export function is_builtin(relation: string): boolean {
  return builtins.has(relation);
}

// Whether a filled-in comparison holds; a side that is not a number makes it false.
export function compare(triple: Triple): boolean {
  if (!number_pattern.test(triple.subject) || !number_pattern.test(triple.object)) return false;
  return builtins.get(triple.relation)!.test(Number(triple.subject), Number(triple.object));
}

// ── Text ─────────────────────────────────────────────────────────────────────

export function triple_text(triple: Triple): string {
  return `${is_denial(triple) ? "not " : ""}${triple.subject} ${base_relation(triple.relation)} ${triple.object}`;
}

export function condition_text(condition: Condition): string {
  return (condition.negated ? "NOT " : "") + triple_text(condition);
}

export function rule_text(rule: Rule): string {
  const conclusion = triple_text(rule.conclusion).replace(/^not /, "NOT ");
  return `${rule.id}: IF ${rule.conditions.map(condition_text).join(" AND ")} THEN ${rule.usually ? "USUALLY " : ""}${conclusion}`;
}

// ── Rules ────────────────────────────────────────────────────────────────────

// The conditions the engine checks: a default also needs its opposite not to be concluded.
export function working_conditions(rule: Rule): Condition[] {
  return rule.usually ? [...rule.conditions, { ...opposite(rule.conclusion), negated: true }] : rule.conditions;
}

// Whether a missing triple of this relation is unknown rather than false; a denial and a comparison are always known.
export function is_open(rule_set: { world: World; relations: Map<string, Relation> }, relation: string): boolean {
  if (relation.startsWith(denial_mark) || is_builtin(relation)) return false;
  return (rule_set.relations.get(relation)?.world || rule_set.world) === "open";
}

// ── Variables ────────────────────────────────────────────────────────────────

export function substitute(triple: Triple, bindings: Bindings): Triple {
  const fill = (term: string) => (is_variable(term) ? (bindings[term] ?? term) : term);
  return { subject: fill(triple.subject), relation: triple.relation, object: fill(triple.object) };
}

// Extends the bindings so the pattern equals the fact, or gives null when it cannot.
export function unify(pattern: Triple, fact: Triple, bindings: Bindings): Bindings | null {
  if (pattern.relation !== fact.relation) return null;
  const next = { ...bindings };
  for (const [term, value] of [[pattern.subject, fact.subject], [pattern.object, fact.object]]) {
    if (!is_variable(term)) {
      if (term !== value) return null;
    } else if (term in next) {
      if (next[term] !== value) return null;
    } else next[term] = value;
  }
  return next;
}
