// A set of ground triples indexed by relation, and finding every way a rule's conditions match it.

// ── Imports ──────────────────────────────────────────────────────────────────

import { compare, is_builtin, substitute, triple_text, unify, type Bindings, type Condition, type Triple } from "./terms.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Store {
  holds: Set<string>;
  by_relation: Map<string, Triple[]>;
}

// One way of filling in a rule's variables, with the triples it used and the ones that had to be absent.
export interface Match {
  bindings: Bindings;
  premises: Triple[];
  absent: Triple[];
}

// ── Storing ──────────────────────────────────────────────────────────────────

export function new_store(): Store {
  return { holds: new Set(), by_relation: new Map() };
}

// Adds a triple; false when it was already there.
export function add(store: Store, triple: Triple): boolean {
  const key = triple_text(triple);
  if (store.holds.has(key)) return false;
  store.holds.add(key);
  const list = store.by_relation.get(triple.relation) ?? [];
  list.push(triple);
  store.by_relation.set(triple.relation, list);
  return true;
}

export function holds(store: Store, triple: Triple): boolean {
  return store.holds.has(triple_text(triple));
}

// ── Matching ─────────────────────────────────────────────────────────────────

// Plain conditions go first, then comparisons, then negated ones, so comparisons and "not" are read fully filled in.
export function ordered(conditions: Condition[]): Condition[] {
  const plain = conditions.filter(condition => !condition.negated && !is_builtin(condition.relation));
  const comparisons = conditions.filter(condition => is_builtin(condition.relation));
  const negated = conditions.filter(condition => condition.negated && !is_builtin(condition.relation));
  return [...plain, ...comparisons, ...negated];
}

export function extend(store: Store, condition: Condition, match: Match): Match[] {
  if (is_builtin(condition.relation)) return compare(substitute(condition, match.bindings)) !== condition.negated ? [match] : [];
  if (condition.negated) {
    const wanted = substitute(condition, match.bindings);
    return holds(store, wanted) ? [] : [{ ...match, absent: [...match.absent, wanted] }];
  }
  const found: Match[] = [];
  for (const fact of store.by_relation.get(condition.relation) ?? []) {
    const bindings = unify(condition, fact, match.bindings);
    if (bindings) found.push({ bindings, premises: [...match.premises, fact], absent: match.absent });
  }
  return found;
}

// Every way the conditions hold together; with skip_negated, the "not" conditions are left out.
export function matches(store: Store, conditions: Condition[], start: Bindings = {}, skip_negated = false): Match[] {
  let current: Match[] = [{ bindings: start, premises: [], absent: [] }];
  for (const condition of ordered(conditions)) {
    if (skip_negated && condition.negated && !is_builtin(condition.relation)) continue;
    current = current.flatMap(match => extend(store, condition, match));
  }
  return current;
}
