// Orders rules so a "not" is only read once everything that could conclude it has run: by kinds of triple when possible, else triple by triple.

// ── Imports ──────────────────────────────────────────────────────────────────

import { add, matches, new_store } from "./store.ts";
import { is_builtin, is_variable, substitute, triple_text, working_conditions, type Condition, type Rule, type Triple } from "./terms.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

// One rule with its variables filled in: its conclusion, the triples it needs and the ones that must be absent.
export interface GroundRule {
  rule: Rule;
  head: Triple;
  premises: Triple[];
  absent: Triple[];
}

// Ground rules in groups to run in order, or the triples that depend on their own negation.
export type GroundPlan = { groups: GroundRule[][]; loop: null } | { groups: null; loop: string[] };

// ── Layers by kind ───────────────────────────────────────────────────────────

// The conditions that read stored triples; comparisons depend on nothing.
function reads(rule: Rule): Condition[] {
  return working_conditions(rule).filter(condition => !is_builtin(condition.relation));
}

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
  const kinds = [...new Set([...given, ...rules.flatMap(rule => [rule.conclusion, ...reads(rule)])].map(signature))];
  const layer = new Map(kinds.map(kind => [kind, 0]));
  const overlapping = (kind: string) => kinds.filter(other => signatures_overlap(kind, other));

  let settled = false;
  for (let round = 0; round <= kinds.length && !settled; round++) {
    settled = true;
    for (const rule of rules) {
      const heads = overlapping(signature(rule.conclusion));
      for (const condition of reads(rule)) {
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
    const needs = reads(rule).flatMap(condition => overlapping(signature(condition)).map(read => layer.get(read)! + (condition.negated ? 1 : 0)));
    rule_strata.set(rule.id, Math.max(0, ...needs));
  }
  return rule_strata;
}

// ── Layers triple by triple ──────────────────────────────────────────────────

// Fills every rule in for the triples that could possibly hold (reading "not" as always true), then orders the
// filled-in rules so each "not" is read only after its triple is settled. A loop through "not" for the same
// triples has no single answer; loops that only appear between different individuals' kinds do not matter here.
export function ground_layers(rules: Rule[], facts: Triple[]): GroundPlan {
  const possible = new_store();
  for (const fact of facts) add(possible, fact);
  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of rules) {
      for (const match of matches(possible, working_conditions(rule), {}, true)) {
        if (add(possible, substitute(rule.conclusion, match.bindings))) changed = true;
      }
    }
  }

  const instances: GroundRule[] = rules.flatMap(rule =>
    matches(possible, working_conditions(rule), {}, true).map(match => ({
      rule,
      head: substitute(rule.conclusion, match.bindings),
      premises: match.premises,
      absent: reads(rule)
        .filter(condition => condition.negated)
        .map(condition => substitute(condition, match.bindings)),
    })),
  );

  // Strongly connected groups of conclusions (Tarjan), each emitted after every group it depends on.
  const needs = new Map<string, string[]>();
  for (const instance of instances) {
    const head = triple_text(instance.head);
    needs.set(head, [...(needs.get(head) ?? []), ...[...instance.premises, ...instance.absent].map(triple_text)]);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const group_of = new Map<string, number>();
  const stack: string[] = [];
  const groups: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, index.size);
    low.set(node, index.get(node)!);
    stack.push(node);
    for (const next of needs.get(node) ?? []) {
      if (!needs.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (!group_of.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) !== index.get(node)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      group_of.set(member, groups.length);
      group.push(member);
    } while (member !== node);
    groups.push(group);
  };
  for (const node of needs.keys()) if (!index.has(node)) visit(node);

  for (const instance of instances) {
    const group = group_of.get(triple_text(instance.head))!;
    if (instance.absent.some(triple => group_of.get(triple_text(triple)) === group)) return { groups: null, loop: groups[group].sort() };
  }
  const ordered: GroundRule[][] = groups.map(() => []);
  for (const instance of instances) ordered[group_of.get(triple_text(instance.head))!].push(instance);
  return { groups: ordered, loop: null };
}
