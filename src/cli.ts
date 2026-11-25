// The command line: check rule sets, explain or query a case, print a model prompt, and benchmark a model against the engine.

// ── Imports ──────────────────────────────────────────────────────────────────

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { explain, infer, query, type Answer } from "./engine.ts";
import { check_draft, draft_prompt, type DraftRequest } from "./draft.ts";
import { extraction_prompt, score_extraction, yaml_of, type ExtractionScore, type ExtractionTask } from "./extract.ts";
import { convert_theory, type ProofWriterRecord } from "./importers/proofwriter.ts";
import { build_prompt, parse_answer, questions_of } from "./prompt.ts";
import { catalog_problems, find_catalog, parse_vocabulary, is_variable, list_rule_set_files, load_rule_set, parse_rule_set, parse_triple, rule_text, RuleSetError, triple_text, type RuleSet } from "./rule_set.ts";
import { ask_model, check_cases, is_correct, score, type CaseResult, type ProgramRunner } from "./runner.ts";

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
  expert-system-rules explain <file.yaml> <case> ["subject relation object" ...]
                                                     why each triple holds or not (default: the case's questions)
  expert-system-rules query <file.yaml> <case> "subject relation ?object"
                                                     every way of filling in the ?variables
  expert-system-rules rules <file.yaml>              list the rules
  expert-system-rules prompt <file.yaml>             print the prompt a model is given
  expert-system-rules bench [--runs N] [file.yaml ...] -- <command ...>
                                                     send each rule set's prompt to a command on stdin and score its JSON answer
  expert-system-rules bench-extract [--every N] [--jobs N] <meta-file.jsonl> -- <command ...>
                                                     give a command every Nth ProofWriter theory's English (default 20), and score
                                                     the facts and rules it writes by the engine's answers to the theory's questions
  expert-system-rules draft --source <text-file> --id <id> --subject <folder> --cite <credit> [--license <spdx>] [--rounds N] -- <command ...>
                                                     ask a command to draft a rule set from a text, send it back with every problem the
                                                     checks find (up to N rounds, default 3), and write it to rulesets/<folder>/<id>.yaml
  expert-system-rules import-proofwriter <meta-file.jsonl> <out-folder> [--every N]
                                                     convert ProofWriter's closed-world theories, check each against the engine,
                                                     and write every Nth one (default 20) as a rule set
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function rule_set_paths(context: CliContext, given: string[]): Promise<string[]> {
  if (given.length) return given.map(path => resolve(context.cwd, path));
  return list_rule_set_files(resolve(context.cwd, "rulesets"));
}

function line(output: Output, text = ""): void {
  output.write(text + "\n");
}

function show_answer(answer: Answer | null): string {
  return answer === null ? "no answer" : String(answer);
}

function report_wrong(context: CliContext, result: CaseResult, label: string): void {
  for (const wrong of result.wrong) {
    line(context.out, `  ${result.id}: "${triple_text(wrong.triple)}" is ${wrong.expected} by the engine, ${label} ${show_answer(wrong.got)}`);
  }
}

async function load_case(context: CliContext, path: string, case_id: string) {
  const rule_set = await load_rule_set(resolve(context.cwd, path));
  const entry = rule_set.cases.find(item => item.id === case_id);
  if (!entry) throw new Error(`${rule_set.id} has no case "${case_id}". Cases: ${rule_set.cases.map(item => item.id).join(", ")}`);
  return { rule_set, entry };
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function check(context: CliContext, paths: string[]): Promise<number> {
  let failures = 0;
  for (const path of paths) {
    const rule_set = await load_rule_set(path);
    const catalog = await find_catalog(path);
    const results = check_cases(rule_set);
    const passed = results.filter(is_correct).length;
    line(context.out, `${rule_set.id}: ${rule_set.rules.length} rules, ${rule_set.facts.length} facts, ${passed}/${results.length} cases match the engine`);
    for (const problem of catalog ? catalog_problems(catalog, path, rule_set) : []) {
      failures++;
      line(context.out, `  ${problem}`);
    }
    for (const result of results.filter(result => !is_correct(result))) {
      failures++;
      report_wrong(context, result, "the case says");
      for (const conflict of result.conflicts) line(context.out, `  ${result.id}: "${triple_text(conflict)}" is concluded both to hold and to be false`);
    }
  }
  return failures ? 1 : 0;
}

async function explain_case(context: CliContext, path: string, case_id: string, wanted: string[]): Promise<number> {
  const { rule_set, entry } = await load_case(context, path, case_id);
  const inference = infer(rule_set, entry.facts);
  const targets = wanted.length ? wanted.map(parse_triple) : questions_of(entry).map(question => question.triple);
  line(context.out, `${rule_set.id} / ${entry.id}: ${entry.facts.map(triple_text).join("; ") || "(no facts)"}`);
  if (entry.note) line(context.out, `  ${entry.note}`);
  for (const target of targets) line(context.out, explain(rule_set, inference, target).join("\n"));
  return 0;
}

async function query_case(context: CliContext, path: string, case_id: string, text: string): Promise<number> {
  const { rule_set, entry } = await load_case(context, path, case_id);
  const pattern = parse_triple(text);
  const found = query(infer(rule_set, entry.facts), pattern);
  const variables = [pattern.subject, pattern.object].filter(is_variable);
  if (!found.length) line(context.out, "no matches");
  for (const bindings of found) line(context.out, variables.length ? variables.map(variable => `${variable} = ${bindings[variable]}`).join(", ") : "holds");
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
    const questions = rule_set.cases.reduce((sum, entry) => sum + questions_of(entry).length, 0);
    for (let run = 1; run <= runs; run++) {
      let answers;
      try {
        answers = parse_answer(await ask_model(command, build_prompt(rule_set), context.run));
      } catch (error) {
        line(context.out, `${rule_set.id} run ${run}: no usable answer (${(error as Error).message})`);
        total += questions;
        continue;
      }
      const result = score(rule_set, answers);
      correct += result.correct;
      total += result.total;
      const right_cases = result.cases.filter(is_correct).length;
      line(context.out, `${rule_set.id} run ${run}: ${result.correct}/${result.total} questions, ${right_cases}/${result.cases.length} cases fully right`);
      for (const wrong of result.cases.filter(item => !is_correct(item))) report_wrong(context, wrong, "the model said");
    }
  }
  line(context.out, `total: ${correct}/${total} questions`);
  return 0;
}

// Takes "--name N" out of the arguments; null when it is not a whole number of 1 or more.
function take_count(args: string[], name: string, fallback: number): { value: number | null; rest: string[] } {
  const at = args.indexOf(name);
  if (at < 0) return { value: fallback, rest: args };
  const value = Number(args[at + 1]);
  return { value: Number.isInteger(value) && value >= 1 ? value : null, rest: args.filter((_, index) => index !== at && index !== at + 1) };
}

async function bench_extract(context: CliContext, args: string[]): Promise<number> {
  const split = args.indexOf("--");
  const command = split < 0 ? [] : args.slice(split + 1);
  const every = take_count(split < 0 ? args : args.slice(0, split), "--every", 20);
  const jobs = take_count(every.rest, "--jobs", 1);
  if (!command.length || every.value === null || jobs.value === null || jobs.rest.length !== 1) {
    line(context.err, "bench-extract needs a ProofWriter meta file and a command after --; --every and --jobs take whole numbers of 1 or more");
    return 2;
  }

  const lines = (await readFile(resolve(context.cwd, jobs.rest[0]), "utf8")).split("\n").filter(text => text.trim());
  const tasks: ExtractionTask[] = [];
  for (const [index, text] of lines.entries()) {
    if (index % every.value !== 0) continue;
    const record = JSON.parse(text) as ProofWriterRecord;
    try {
      const reference_yaml = convert_theory(record);
      tasks.push({ id: record.id, english: record.theory, reference_yaml, reference: parse_rule_set(reference_yaml, record.id) });
    } catch {
      // A theory the engine cannot take as the reference is left out, as import-proofwriter reports.
    }
  }

  const scores: ExtractionScore[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      try {
        scores[index] = score_extraction(task, await ask_model(command, extraction_prompt(task), context.run));
      } catch (error) {
        scores[index] = { id: task.id, correct: 0, total: task.reference.cases.reduce((sum, entry) => sum + questions_of(entry).length, 0), problem: (error as Error).message };
      }
    }
  };
  await Promise.all(Array.from({ length: jobs.value }, worker));

  for (const result of scores) line(context.out, `${result.id}: ${result.correct}/${result.total} answers${result.problem ? ` (unusable: ${result.problem})` : ""}`);
  const correct = scores.reduce((sum, result) => sum + result.correct, 0);
  const total = scores.reduce((sum, result) => sum + result.total, 0);
  const perfect = scores.filter(result => result.correct === result.total && !result.problem).length;
  const unusable = scores.filter(result => result.problem).length;
  line(context.out, `total: ${correct}/${total} answers, ${perfect}/${scores.length} theories fully right, ${unusable} unusable`);
  return 0;
}

// Takes "--name value" out of the arguments.
function take_value(args: string[], name: string): { value: string; rest: string[] } {
  const at = args.indexOf(name);
  if (at < 0 || at + 1 >= args.length) return { value: "", rest: args };
  return { value: args[at + 1], rest: args.filter((_, index) => index !== at && index !== at + 1) };
}

async function draft(context: CliContext, args: string[]): Promise<number> {
  const split = args.indexOf("--");
  const command = split < 0 ? [] : args.slice(split + 1);
  let options = split < 0 ? args : args.slice(0, split);
  const read = (name: string): string => {
    const taken = take_value(options, name);
    options = taken.rest;
    return taken.value;
  };
  const [source, id, subject, cite, license] = ["--source", "--id", "--subject", "--cite", "--license"].map(read);
  const rounds = take_count(options, "--rounds", 3);
  if (!command.length || !source || !id || !subject || !cite || rounds.value === null || rounds.rest.length) {
    line(context.err, "draft needs --source, --id, --subject and --cite, and a command after --; --rounds takes a whole number of 1 or more");
    return 2;
  }

  const path = resolve(context.cwd, "rulesets", subject, `${id}.yaml`);
  const catalog = await find_catalog(path);
  if (!catalog) {
    line(context.err, `no catalog.yaml above ${path}; run draft from the repository`);
    return 2;
  }
  if (!catalog.subjects.has(subject)) {
    line(context.err, `the subject "${subject}" is not listed in catalog.yaml; add it there first`);
    return 2;
  }
  const core_file = join(catalog.root, "vocabularies", "core.yaml");
  const core = parse_vocabulary(await readFile(core_file, "utf8"), core_file);
  const request: DraftRequest = { source_text: await readFile(resolve(context.cwd, source), "utf8"), id, subject, license: license || "CC-BY-SA-4.0", cite };

  let previous: { yaml: string; problems: string[] } | undefined;
  for (let round = 1; round <= rounds.value; round++) {
    const yaml = yaml_of(await ask_model(command, draft_prompt(request, catalog, core, previous), context.run)).trim() + "\n";
    const checked = await check_draft(yaml, path, request, catalog);
    if (checked.rule_set) {
      await mkdir(resolve(context.cwd, "rulesets", subject), { recursive: true });
      await writeFile(path, yaml);
      line(context.out, `round ${round}: accepted, ${checked.rule_set.rules.length} rules and ${checked.rule_set.cases.length} cases, written to ${path}`);
      line(context.out, "Review every rule against its quote before opening a pull request.");
      return 0;
    }
    line(context.out, `round ${round}: ${checked.problems.length} problems`);
    for (const problem of checked.problems) line(context.out, `  ${problem}`);
    previous = { yaml, problems: checked.problems };
  }
  const rejected = resolve(context.cwd, `${id}.rejected.yaml`);
  await writeFile(rejected, [...previous!.problems.map(problem => `# ${problem}`), previous!.yaml].join("\n"));
  line(context.out, `not accepted after ${rounds.value} rounds; the last draft and its problems are in ${rejected}`);
  return 1;
}

async function import_proofwriter(context: CliContext, args: string[]): Promise<number> {
  let every = 20;
  const every_at = args.indexOf("--every");
  if (every_at >= 0) {
    every = Number(args[every_at + 1]);
    if (!Number.isInteger(every) || every < 1) {
      line(context.err, "--every needs a whole number of 1 or more");
      return 2;
    }
    args = args.filter((_, index) => index !== every_at && index !== every_at + 1);
  }
  if (args.length !== 2) {
    context.err.write(usage);
    return 2;
  }
  const [source, folder] = args.map(path => resolve(context.cwd, path));
  const lines = (await readFile(source, "utf8")).split("\n").filter(text => text.trim());
  await mkdir(folder, { recursive: true });

  let theories_matching = 0;
  let questions_matching = 0;
  let questions = 0;
  let written = 0;
  const refused: string[] = [];
  const disagreeing: string[] = [];
  for (const [index, text] of lines.entries()) {
    const record = JSON.parse(text) as ProofWriterRecord;
    let rule_set: RuleSet;
    let yaml: string;
    try {
      yaml = convert_theory(record);
      rule_set = parse_rule_set(yaml, record.id);
    } catch (error) {
      refused.push(`${record.id}: ${error instanceof RuleSetError ? error.problems.join("; ") : (error as Error).message}`);
      continue;
    }
    const total = rule_set.cases.reduce((sum, entry) => sum + questions_of(entry).length, 0);
    const wrong = check_cases(rule_set).reduce((sum, result) => sum + result.wrong.length, 0);
    questions += total;
    questions_matching += total - wrong;
    if (wrong === 0) theories_matching++;
    else disagreeing.push(`${record.id}: the engine disagrees with ${wrong} of ProofWriter's ${total} answers`);
    if (index % every === 0) {
      await writeFile(join(folder, `${record.id.toLowerCase()}.yaml`), yaml);
      written++;
    }
  }
  line(context.out, `${lines.length} theories: ${theories_matching} fully reproduced, ${disagreeing.length} with different answers, ${refused.length} refused`);
  line(context.out, `${questions_matching}/${questions} answers match ProofWriter`);
  line(context.out, `wrote ${written} rule sets to ${folder}`);
  for (const failure of [...disagreeing, ...refused]) line(context.out, `  ${failure}`);
  return disagreeing.length || refused.length ? 1 : 0;
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
        return await explain_case(context, rest[0], rest[1], rest.slice(2));
      case "query":
        if (rest.length !== 3) break;
        return await query_case(context, rest[0], rest[1], rest[2]);
      case "prompt":
        if (rest.length !== 1) break;
        line(context.out, build_prompt(await load_rule_set(resolve(context.cwd, rest[0]))));
        return 0;
      case "rules":
        if (rest.length !== 1) break;
        line(context.out, (await load_rule_set(resolve(context.cwd, rest[0]))).rules.map(rule_text).join("\n"));
        return 0;
      case "bench":
        return await bench(context, rest);
      case "bench-extract":
        return await bench_extract(context, rest);
      case "draft":
        return await draft(context, rest);
      case "import-proofwriter":
        return await import_proofwriter(context, rest);
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
