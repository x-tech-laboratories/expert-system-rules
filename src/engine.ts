// Forward chaining over a rule set, one layer at a time so "not x" is only read once x is settled, with a justification for every answer.

// ── Imports ──────────────────────────────────────────────────────────────────

import type { Condition, Rule, RuleSet } from "./rule_set.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Inference {
  holds: Set<string>;
  reasons: Map<string, Rule>;
}

// ── Text ─────────────────────────────────────────────────────────────────────

export function condition_text(condition: Condition): string {
  return condition.negated ? `NOT ${condition.fact}` : condition.fact;
}

export function rule_text(rule: Rule): string {
  return `${rule.id}: IF ${rule.conditions.map(condition_text).join(" AND ")} THEN ${rule.conclusion}`;
}

// ── Inference ────────────────────────────────────────────────────────────────

function satisfied(condition: Condition, holds: Set<string>): boolean {
  return holds.has(condition.fact) !== condition.negated;
}

export function infer(rule_set: RuleSet, facts: Iterable<string>): Inference {
  const holds = new Set(facts);
  const reasons = new Map<string, Rule>();
  const top = Math.max(0, ...rule_set.strata.values());
  for (let stratum = 0; stratum <= top; stratum++) {
    const layer = rule_set.rules.filter(rule => rule_set.strata.get(rule.conclusion) === stratum);
    let changed = true;
    while (changed) {
      changed = false;
      for (const rule of layer) {
        if (holds.has(rule.conclusion) || !rule.conditions.every(condition => satisfied(condition, holds))) continue;
        holds.add(rule.conclusion);
        reasons.set(rule.conclusion, rule);
        changed = true;
      }
    }
  }
  return { holds, reasons };
}

// The conclusions that hold for these facts, in name order.
export function conclusions_for(rule_set: RuleSet, facts: Iterable<string>): string[] {
  const { holds } = infer(rule_set, facts);
  return rule_set.conclusions.filter(conclusion => holds.has(conclusion));
}

// ── Explaining ───────────────────────────────────────────────────────────────

// An indented tree of why a fact holds or not, down to the given features.
export function explain(rule_set: RuleSet, inference: Inference, fact: string, depth = 0, seen = new Set<string>()): string[] {
  const pad = "  ".repeat(depth);
  if (rule_set.features.has(fact)) return [`${pad}${fact}: ${inference.holds.has(fact) ? "given" : "not given"}`];
  if (seen.has(fact)) return [`${pad}${fact}: see above`];
  seen.add(fact);

  const reason = inference.reasons.get(fact);
  if (reason) {
    const lines = [`${pad}${fact} holds by ${rule_text(reason)}`];
    for (const condition of reason.conditions) lines.push(...explain(rule_set, inference, condition.fact, depth + 1, seen));
    return lines;
  }

  const lines = [`${pad}${fact} does not hold`];
  for (const rule of rule_set.rules.filter(rule => rule.conclusion === fact)) {
    const failed = rule.conditions.find(condition => !satisfied(condition, inference.holds))!;
    lines.push(`${pad}  ${rule.id} fails at ${condition_text(failed)}`);
    lines.push(...explain(rule_set, inference, failed.fact, depth + 2, seen));
  }
  return lines;
}
