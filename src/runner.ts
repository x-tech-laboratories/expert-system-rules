// Checks a rule set's cases against the engine, and scores an AI model's true/false answers against the engine question by question.

// ── Imports ──────────────────────────────────────────────────────────────────

import { run_program, type ProgramOptions, type ProgramResult } from "@x-tech-laboratories/x-libs/agent/programs";

import { holds, infer } from "./engine.ts";
import { questions_of } from "./prompt.ts";
import type { RuleSet, Triple } from "./rule_set.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface WrongAnswer {
  triple: Triple;
  expected: boolean;
  got: boolean | null;
}

export interface CaseResult {
  id: string;
  wrong: WrongAnswer[];
}

export interface Score {
  cases: CaseResult[];
  correct: number;
  total: number;
}

export type ProgramRunner = (argv: readonly string[], options: ProgramOptions) => Promise<ProgramResult>;

// ── Comparing ────────────────────────────────────────────────────────────────

export function is_correct(result: CaseResult): boolean {
  return result.wrong.length === 0;
}

// Compares each case's written expect and expect_not (got) with what the engine concludes (expected).
export function check_cases(rule_set: RuleSet): CaseResult[] {
  return rule_set.cases.map(entry => {
    const inference = infer(rule_set, entry.facts);
    const wrong = questions_of(entry)
      .map(question => ({ triple: question.triple, expected: holds(inference, question.triple), got: question.answer }))
      .filter(answer => answer.got !== answer.expected);
    return { id: entry.id, wrong };
  });
}

// Scores a model's answers against the engine, one point per question.
export function score(rule_set: RuleSet, answers: Map<string, (boolean | null)[]>): Score {
  let total = 0;
  const cases = rule_set.cases.map(entry => {
    const inference = infer(rule_set, entry.facts);
    const given = answers.get(entry.id) ?? [];
    const questions = questions_of(entry);
    total += questions.length;
    const wrong = questions
      .map((question, index) => ({ triple: question.triple, expected: holds(inference, question.triple), got: given[index] ?? null }))
      .filter(answer => answer.got !== answer.expected);
    return { id: entry.id, wrong };
  });
  const missed = cases.reduce((sum, result) => sum + result.wrong.length, 0);
  return { cases, correct: total - missed, total };
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
