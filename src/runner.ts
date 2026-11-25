// Checks a rule set's cases against the engine, and scores an AI model's answers against the engine cell by cell.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_program, type ProgramOptions, type ProgramResult } from "@x-tech-laboratories/x-libs/agent/programs";

import { conclusions_for } from "./engine.ts";
import type { RuleSet } from "./rule_set.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface CaseResult {
  id: string;
  missing: string[];
  extra: string[];
}

export interface Score {
  cases: CaseResult[];
  correct_cells: number;
  total_cells: number;
}

export type ProgramRunner = (argv: readonly string[], options: ProgramOptions) => Promise<ProgramResult>;

// ── Comparing ────────────────────────────────────────────────────────────────

function compare(id: string, expected: string[], got: Iterable<string>): CaseResult {
  const got_set = new Set(got);
  return {
    id,
    missing: expected.filter(fact => !got_set.has(fact)),
    extra: [...got_set].filter(fact => !expected.includes(fact)).sort(),
  };
}

export function is_correct(result: CaseResult): boolean {
  return result.missing.length === 0 && result.extra.length === 0;
}

// Compares each case's written "expect" with what the engine concludes.
export function check_cases(rule_set: RuleSet): CaseResult[] {
  return rule_set.cases.map(entry => compare(entry.id, conclusions_for(rule_set, entry.facts), entry.expect));
}

// Scores answers per case against the engine; every conclusion of every case is one cell, right or wrong.
export function score(rule_set: RuleSet, answers: Map<string, string[]>): Score {
  const cases = rule_set.cases.map(entry => compare(entry.id, conclusions_for(rule_set, entry.facts), answers.get(entry.id) ?? []));
  const total_cells = rule_set.cases.length * rule_set.conclusions.length;
  const known = new Set(rule_set.conclusions);
  const wrong = cases.reduce((sum, result) => sum + result.missing.length + result.extra.filter(fact => known.has(fact)).length, 0);
  return { cases, correct_cells: total_cells - wrong, total_cells };
}

// ── Asking a model ───────────────────────────────────────────────────────────

// Runs the model's command with the prompt on its standard input and returns what it printed.
export async function ask_model(command: readonly string[], prompt: string, run: ProgramRunner = run_program): Promise<string> {
  const result = await run(command, { stdin: prompt, stdout: "keep", stderr: "keep", own_group: true });
  if (result.exit_code !== 0) {
    const reason = result.stderr.trim().split("\n")[0] || `exit code ${result.exit_code}`;
    throw new Error(`${command[0]} failed: ${reason}`);
  }
  return result.stdout;
}
