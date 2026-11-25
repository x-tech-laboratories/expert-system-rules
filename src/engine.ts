// Forward chaining over triples, layer by layer so "not" is only read once settled, with a justification for every answer.

// ── Imports ──────────────────────────────────────────────────────────────────

import { condition_text, is_denial, is_open, is_variable, opposite, rule_text, triple_text, working_conditions, type Condition, type Rule, type RuleSet, type Triple } from "./rule_set.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export type Bindings = Record<string, string>;

export interface Reason {
  rule: Rule;
  premises: Triple[];
  absent: Triple[];
}

export interface Inference {
  given: Set<string>;
  holds: Set<string>;
  by_relation: Map<string, Triple[]>;
  reasons: Map<string, Reason>;
  // Triples concluded both to hold and to be false.
  conflicts: Triple[];
}

// What the engine says about a ground triple: it holds, it is false, or (in an open world) nothing settles it.
export type Answer = true | false | "unknown";

interface Match {
  bindings: Bindings;
  premises: Triple[];
  absent: Triple[];
}

// ── Triples ──────────────────────────────────────────────────────────────────

export function substitute(triple: Triple, bindings: Bindings): Triple {
  const fill = (term: string) => (is_variable(term) ? (bindings[term] ?? term) : term);
  return { subject: fill(triple.subject), relation: triple.relation, object: fill(triple.object) };
}

function is_ground(triple: Triple): boolean {
  return !is_variable(triple.subject) && !is_variable(triple.object);
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

function add(inference: Inference, triple: Triple): boolean {
  const key = triple_text(triple);
  if (inference.holds.has(key)) return false;
  inference.holds.add(key);
  const list = inference.by_relation.get(triple.relation) ?? [];
  list.push(triple);
  inference.by_relation.set(triple.relation, list);
  return true;
}

export function holds(inference: Inference, triple: Triple): boolean {
  return inference.holds.has(triple_text(triple));
}

// ── Matching ─────────────────────────────────────────────────────────────────

// Conditions without "not" go first, so every negated one is fully filled in when it is read.
function ordered(conditions: Condition[]): Condition[] {
  return [...conditions.filter(condition => !condition.negated), ...conditions.filter(condition => condition.negated)];
}

function extend(inference: Inference, condition: Condition, match: Match): Match[] {
  if (condition.negated) {
    const wanted = substitute(condition, match.bindings);
    return holds(inference, wanted) ? [] : [{ ...match, absent: [...match.absent, wanted] }];
  }
  const found: Match[] = [];
  for (const fact of inference.by_relation.get(condition.relation) ?? []) {
    const bindings = unify(condition, fact, match.bindings);
    if (bindings) found.push({ bindings, premises: [...match.premises, fact], absent: match.absent });
  }
  return found;
}

function matches(inference: Inference, conditions: Condition[], start: Bindings = {}): Match[] {
  let current: Match[] = [{ bindings: start, premises: [], absent: [] }];
  for (const condition of ordered(conditions)) current = current.flatMap(match => extend(inference, condition, match));
  return current;
}

// ── Inference ────────────────────────────────────────────────────────────────

export function infer(rule_set: RuleSet, extra_facts: Triple[] = []): Inference {
  const inference: Inference = { given: new Set(), holds: new Set(), by_relation: new Map(), reasons: new Map(), conflicts: [] };
  for (const fact of [...rule_set.facts, ...extra_facts]) {
    add(inference, fact);
    inference.given.add(triple_text(fact));
  }

  const top = Math.max(0, ...rule_set.rule_strata.values());
  for (let stratum = 0; stratum <= top; stratum++) {
    const layer = rule_set.rules.filter(rule => rule_set.rule_strata.get(rule.id) === stratum);
    let changed = true;
    while (changed) {
      changed = false;
      for (const rule of layer) {
        for (const match of matches(inference, working_conditions(rule))) {
          const conclusion = substitute(rule.conclusion, match.bindings);
          if (!add(inference, conclusion)) continue;
          inference.reasons.set(triple_text(conclusion), { rule, premises: match.premises, absent: match.absent });
          changed = true;
        }
      }
    }
  }
  for (const list of inference.by_relation.values()) {
    for (const triple of list) if (!is_denial(triple) && holds(inference, opposite(triple))) inference.conflicts.push(triple);
  }
  return inference;
}

// True when the triple holds; false when it is denied, or missing from a closed world; unknown when missing from an open one.
export function answer(rule_set: RuleSet, inference: Inference, triple: Triple): Answer {
  if (holds(inference, triple)) return true;
  if (holds(inference, opposite(triple)) || !is_open(rule_set, triple.relation)) return false;
  return "unknown";
}

// Every way of filling in the pattern's variables that makes it hold.
export function query(inference: Inference, pattern: Triple): Bindings[] {
  return matches(inference, [{ ...pattern, negated: false }]).map(match => match.bindings);
}

// ── Explaining ───────────────────────────────────────────────────────────────

// An indented tree of why a triple holds or does not, down to the given facts.
export function explain(rule_set: RuleSet, inference: Inference, triple: Triple, depth = 0, seen = new Set<string>()): string[] {
  const pad = "  ".repeat(depth);
  const key = triple_text(triple);
  if (inference.given.has(key)) return [`${pad}${key}: given`];
  if (seen.has(key)) return [`${pad}${key}: see above`];
  seen.add(key);

  const reason = inference.reasons.get(key);
  if (reason) {
    const lines = [`${pad}${key} holds by ${rule_text(reason.rule)}`];
    for (const premise of reason.premises) lines.push(...explain(rule_set, inference, premise, depth + 1, seen));
    for (const missing of reason.absent) lines.push(...explain(rule_set, inference, missing, depth + 1, seen));
    return lines;
  }

  const denied = !is_denial(triple) && holds(inference, opposite(triple));
  const unknown = !denied && !is_denial(triple) && is_open(rule_set, triple.relation);
  const verdict = denied ? "is false" : unknown ? `is unknown (${triple.relation} is open-world)` : "does not hold";
  const candidates = rule_set.rules.flatMap(rule => {
    const bindings = unify(rule.conclusion, triple, {});
    return bindings ? [{ rule, bindings }] : [];
  });
  const lines = [`${pad}${key} ${verdict}${candidates.length || denied ? "" : ": it is not given and no rule concludes it"}`];
  if (denied) lines.push(...explain(rule_set, inference, opposite(triple), depth + 1, seen));

  for (const { rule, bindings } of candidates) {
    let current: Match[] = [{ bindings, premises: [], absent: [] }];
    for (const condition of ordered(working_conditions(rule))) {
      const next = current.flatMap(match => extend(inference, condition, match));
      if (next.length) {
        current = next;
        continue;
      }
      const blocking = substitute(condition, current[0].bindings);
      const overridden = rule.usually && condition.negated && triple_text(blocking) === triple_text(opposite(substitute(rule.conclusion, current[0].bindings)));
      if (overridden) lines.push(`${pad}  ${rule.id} usually concludes it, but the exception "${triple_text(blocking)}" holds`);
      else {
        lines.push(`${pad}  ${rule.id} fails at ${condition_text({ ...blocking, negated: condition.negated })}`);
        if (is_ground(blocking)) lines.push(...explain(rule_set, inference, blocking, depth + 2, seen));
      }
      break;
    }
  }
  return lines;
}
