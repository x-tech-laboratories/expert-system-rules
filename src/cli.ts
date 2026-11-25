// The command line: check rule sets, explain a case, print a model prompt, and benchmark a model against the engine.

// ── Imports ──────────────────────────────────────────────────────────────────

import { join } from "node:path";

import { explain, infer } from "./engine.ts";
import { build_prompt, parse_answer, rules_listing } from "./prompt.ts";
import { list_rule_set_files, load_rule_set, type RuleSet } from "./rule_set.ts";
import { ask_model, check_cases, is_correct, score, type ProgramRunner } from "./runner.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Output {
  write(text: string): void;
}

export interface CliContext {
  cwd: string;
  out: Output;
  err: Output;
  run?: ProgramRunner;
}

const usage = `Usage:
  expert-system-rules check [file.yaml ...]          validate rule sets and run their cases (default: every file in rulesets/)
  expert-system-rules explain <file.yaml> <case> [conclusion ...]
  expert-system-rules rules <file.yaml>              list the rules compactly
  expert-system-rules prompt <file.yaml>             print the prompt a model is given
  expert-system-rules bench [--runs N] [file.yaml ...] -- <command ...>
                                                     send each rule set's prompt to a command on stdin and score its JSON answer
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function rule_set_paths(context: CliContext, given: string[]): Promise<string[]> {
  if (given.length) return given.map(path => join(context.cwd, path));
  return list_rule_set_files(join(context.cwd, "rulesets"));
}

function line(output: Output, text = ""): void {
  output.write(text + "\n");
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function check(context: CliContext, paths: string[]): Promise<number> {
  let failures = 0;
  for (const path of paths) {
    const rule_set = await load_rule_set(path);
    const results = check_cases(rule_set);
    const passed = results.filter(is_correct).length;
    line(context.out, `${rule_set.id}: ${rule_set.rules.length} rules, ${passed}/${results.length} cases match the engine`);
    for (const result of results.filter(result => !is_correct(result))) {
      failures++;
      line(context.out, `  ${result.id}: expect lists ${result.extra.join(", ") || "nothing extra"}, misses ${result.missing.join(", ") || "nothing"}`);
    }
  }
  return failures ? 1 : 0;
}

async function explain_case(context: CliContext, path: string, case_id: string, wanted: string[]): Promise<number> {
  const rule_set = await load_rule_set(path);
  const entry = rule_set.cases.find(item => item.id === case_id);
  if (!entry) {
    line(context.err, `${rule_set.id} has no case "${case_id}". Cases: ${rule_set.cases.map(item => item.id).join(", ")}`);
    return 2;
  }
  const inference = infer(rule_set, entry.facts);
  const targets = wanted.length ? wanted : rule_set.goals.length ? rule_set.goals : rule_set.conclusions;
  line(context.out, `${rule_set.id} / ${entry.id}: ${entry.facts.join(", ") || "(no facts)"}`);
  if (entry.note) line(context.out, `  ${entry.note}`);
  for (const target of targets) line(context.out, explain(rule_set, inference, target).join("\n"));
  return 0;
}

async function bench(context: CliContext, args: string[]): Promise<number> {
  const split = args.indexOf("--");
  const command = split < 0 ? [] : args.slice(split + 1);
  let options = split < 0 ? args : args.slice(0, split);
  if (!command.length) {
    line(context.err, "bench needs a command after --, such as: -- claude -p --model haiku");
    return 2;
  }
  let runs = 1;
  const runs_at = options.indexOf("--runs");
  if (runs_at >= 0) {
    runs = Number(options[runs_at + 1]);
    if (!Number.isInteger(runs) || runs < 1) {
      line(context.err, "--runs needs a whole number of 1 or more");
      return 2;
    }
    options = options.filter((_, index) => index !== runs_at && index !== runs_at + 1);
  }

  let correct = 0;
  let total = 0;
  for (const path of await rule_set_paths(context, options)) {
    const rule_set: RuleSet = await load_rule_set(path);
    for (let run = 1; run <= runs; run++) {
      let answers: Map<string, string[]>;
      try {
        answers = parse_answer(await ask_model(command, build_prompt(rule_set), context.run));
      } catch (error) {
        line(context.out, `${rule_set.id} run ${run}: no usable answer (${(error as Error).message})`);
        total += rule_set.cases.length * rule_set.conclusions.length;
        continue;
      }
      const result = score(rule_set, answers);
      correct += result.correct_cells;
      total += result.total_cells;
      const right_cases = result.cases.filter(is_correct).length;
      line(context.out, `${rule_set.id} run ${run}: ${result.correct_cells}/${result.total_cells} cells, ${right_cases}/${result.cases.length} cases fully right`);
      for (const wrong of result.cases.filter(item => !is_correct(item))) {
        line(context.out, `  ${wrong.id}: missing ${wrong.missing.join(", ") || "none"}; extra ${wrong.extra.join(", ") || "none"}`);
      }
    }
  }
  line(context.out, `total: ${correct}/${total} cells`);
  return 0;
}

// ── Entry ────────────────────────────────────────────────────────────────────

export async function run_cli(args: string[], context: CliContext): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case "check":
        return await check(context, await rule_set_paths(context, rest));
      case "explain":
        if (rest.length < 2) break;
        return await explain_case(context, join(context.cwd, rest[0]), rest[1], rest.slice(2));
      case "prompt":
        if (rest.length !== 1) break;
        line(context.out, build_prompt(await load_rule_set(join(context.cwd, rest[0]))));
        return 0;
      case "rules":
        if (rest.length !== 1) break;
        line(context.out, rules_listing(await load_rule_set(join(context.cwd, rest[0]))).join("\n"));
        return 0;
      case "bench":
        return await bench(context, rest);
      case undefined:
      case "help":
      case "--help":
        context.out.write(usage);
        return 0;
    }
  } catch (error) {
    line(context.err, (error as Error).message);
    return 1;
  }
  context.err.write(usage);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await run_cli(process.argv.slice(2), { cwd: process.cwd(), out: process.stdout, err: process.stderr });
}
