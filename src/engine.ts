// Forward chaining over triples, layer by layer so "not" is only read once settled, with a justification for every answer.
// Rules layered by kind of triple run layer by layer; rules that only settle triple by triple run as filled-in rules in their order.

// ── Imports ──────────────────────────────────────────────────────────────────

import { ground_layers } from "./layers.ts";
import type { RuleSet } from "./rule_set.ts";
import { add, extend, holds, matches, ordered, type Match, type Store } from "./store.ts";
import {
  condition_text,
  is_builtin,
  is_denial,
  is_ground,
  is_open,
  opposite,
  rule_text,
  substitute,
  triple_text,
  unify,
  working_conditions,
  type Bindings,
  type Rule,
  type Triple,
} from "./terms.ts";

export { holds } from "./store.ts";
export { substitute, unify, type Bindings } from "./terms.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Reason {
  rule: Rule;
  premises: Triple[];
  absent: Triple[];
}

export interface Inference extends Store {
  given: Set<string>;
  reasons: Map<string, Reason>;
  // Triples concluded both to hold and to be false.
  conflicts: Triple[];
}

// What the engine says about a ground triple: it holds, it is false, or (in an open world) nothing settles it.
export type Answer = true | false | "unknown";

// ── Inference ────────────────────────────────────────────────────────────────

export function infer(rule_set: RuleSet, extra_facts: Triple[] = []): Inference {
  const inference: Inference = { given: new Set(), holds: new Set(), by_relation: new Map(), reasons: new Map(), conflicts: [] };
  for (const fact of [...rule_set.facts, ...extra_facts]) {
    add(inference, fact);
    inference.given.add(triple_text(fact));
  }

  if (rule_set.rule_strata) run_layers(rule_set.rules, rule_set.rule_strata, inference);
  else run_ground(rule_set, inference);
  for (const list of inference.by_relation.values()) {
    for (const triple of list) if (!is_denial(triple) && holds(inference, opposite(triple))) inference.conflicts.push(triple);
  }
  return inference;
}

function conclude(inference: Inference, rule: Rule, conclusion: Triple, premises: Triple[], absent: Triple[]): boolean {
  if (!add(inference, conclusion)) return false;
  inference.reasons.set(triple_text(conclusion), { rule, premises, absent });
  return true;
}

function run_layers(rules: Rule[], rule_strata: Map<string, number>, inference: Inference): void {
  const top = Math.max(0, ...rule_strata.values());
  for (let stratum = 0; stratum <= top; stratum++) {
    const layer = rules.filter(rule => rule_strata.get(rule.id) === stratum);
    let changed = true;
    while (changed) {
      changed = false;
      for (const rule of layer) {
        for (const match of matches(inference, working_conditions(rule))) {
          if (conclude(inference, rule, substitute(rule.conclusion, match.bindings), match.premises, match.absent)) changed = true;
        }
      }
    }
  }
}

// Runs the filled-in rules group by group; a "not" only reads triples of earlier groups, which are settled.
function run_ground(rule_set: RuleSet, inference: Inference): void {
  const plan = ground_layers(rule_set.rules, [...inference.by_relation.values()].flat());
  if (!plan.groups) throw new Error(`${rule_set.id}: with these facts a conclusion depends on its own negation: ${plan.loop.join(", ")}`);
  for (const group of plan.groups) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const instance of group) {
        if (!instance.premises.every(premise => holds(inference, premise)) || instance.absent.some(missing => holds(inference, missing))) continue;
        if (conclude(inference, instance.rule, instance.head, instance.premises, instance.absent)) changed = true;
      }
    }
  }
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
      if (is_builtin(condition.relation)) {
        lines.push(`${pad}  ${rule.id} fails at ${condition_text({ ...blocking, negated: condition.negated })}, which is false`);
        break;
      }
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
