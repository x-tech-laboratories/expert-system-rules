import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run_cli } from "../src/cli.ts";
import { extraction_grammar, extraction_prompt, score_extraction, type ExtractionTask } from "../src/extract.ts";
import { convert_theory } from "../src/importers/proofwriter.ts";
import { parse_rule_set } from "../src/rule_set.ts";
import type { ProgramRunner } from "../src/runner.ts";
import { sample_record } from "./fixtures/proofwriter.ts";

// ============================================================================
// Helpers
// ============================================================================

function task(): ExtractionTask {
  const reference_yaml = convert_theory(sample_record);
  return { id: sample_record.id, english: sample_record.theory, reference_yaml, reference: parse_rule_set(reference_yaml, sample_record.id) };
}

// A faithful translation, written the way a model might, without the guard the converter adds for rule 2.
const faithful = `
facts:
  - bald_eagle is big
  - cow needs bald_eagle
  - bald_eagle is_a thing
  - cow is_a thing
rules:
  - { id: R1, if: [?x is big, not ?x needs cow], then: ?x chases cow }
  - { id: R2, if: [?x is_a thing, not ?x is quiet], then: ?x is loud }
  - { id: R3, if: [cow needs ?x], then: ?x is needed }
`;

async function run(args: string[], cwd: string, runner?: ProgramRunner) {
  let out = "";
  let err = "";
  const code = await run_cli(args, { cwd, out: { write: text => void (out += text) }, err: { write: text => void (err += text) }, run: runner });
  return { code, out, err };
}

// ============================================================================
// Prompt and scoring
// ============================================================================

describe("extraction", () => {
  it("gives the model the English, the relations and the names, but not the rules", () => {
    const prompt = extraction_prompt(task());

    expect(prompt).toContain(sample_record.theory);
    expect(prompt).toContain("Use these names for individuals and properties, in lower_snake_case: bald_eagle, big, cow, loud, needed, quiet.");
    expect(prompt).toContain("chases (The subject chases the object.)");
    expect(prompt).toContain("is_a (The subject is one of the things the theory talks about.)");
    expect(prompt).not.toContain("?x chases cow");
  });

  it("writes a grammar of the theory's names and relations", () => {
    expect(extraction_grammar(task()).split("\n")).toEqual([
      'root ::= "facts:\\n" fact{0,15} "rules:\\n" rule{1,2}',
      'fact ::= "  - " name " " relation " " name "\\n"',
      'rule ::= "  - { id: R" [1-9] [0-9]? ", if: [" condition (", " condition)* "], then: " term " " conclusion " " term " }\\n"',
      'condition ::= "not "? term " " relation " " term',
      "term ::= name | variable",
      'variable ::= "?x" | "?y" | "?z"',
      'name ::= "bald_eagle" | "big" | "cow" | "loud" | "needed" | "quiet" | "thing"',
      'relation ::= "chases" | "is" | "is_a" | "needs" | "visits"',
      'conclusion ::= "chases" | "is" | "needs" | "visits"',
      "",
    ]);
  });

  it("explains the guard, and shows a refused reply and its reason on a retry", () => {
    expect(extraction_prompt(task())).toContain('Never write "is_a thing" as a rule\'s conclusion.');
    expect(extraction_prompt(task())).not.toContain("Your previous answer was refused");
    const again = extraction_prompt(task(), { reply: "facts: []\n", problem: "rule R1: ?x must appear in a condition without not" });
    expect(again).toContain("Your previous answer was refused:\nrule R1: ?x must appear in a condition without not\n\nPrevious answer:\nfacts: []");
  });

  it("lets a rule conclude is_a only when the theory itself has that relation", () => {
    const reference_yaml = convert_theory(sample_record).replace("is_a: The subject is one of the things the theory talks about.", "is_a: The subject is an instance of this kind.");
    const own: ExtractionTask = { id: "own", english: sample_record.theory, reference_yaml, reference: parse_rule_set(reference_yaml, "own") };

    expect(extraction_grammar(own)).toContain('conclusion ::= "chases" | "is" | "is_a" | "needs" | "visits"');
  });

  it("scores a faithful translation, fenced or not", () => {
    expect(score_extraction(task(), faithful)).toEqual({ id: sample_record.id, correct: 4, total: 4, problem: "" });
    expect(score_extraction(task(), "Here you go:\n```yaml\n" + faithful + "```\nDone.")).toMatchObject({ correct: 4, problem: "" });
  });

  it("scores a wrong translation by the answers it gets wrong", () => {
    expect(score_extraction(task(), faithful.replace("not ?x needs cow", "?x needs cow"))).toMatchObject({ correct: 3, total: 4, problem: "" });
  });

  it("counts a reply it cannot use as all wrong, saying why", () => {
    expect(score_extraction(task(), "facts: [unclosed")).toMatchObject({ correct: 0, total: 4, problem: expect.stringMatching(/^not valid YAML/) });
    expect(score_extraction(task(), "- just a list")).toMatchObject({ correct: 0, problem: "the reply holds no facts and rules" });
    expect(score_extraction(task(), "rules:\n  - { id: R1, if: [not ?x is big], then: ?x flies cow }")).toMatchObject({
      correct: 0,
      problem: `rule R1: ?x must appear in a condition without "not" that is not a comparison; the relation "flies" is used but not listed under "relations" or in a vocabulary`,
    });
  });

  it("adds the guard relation when the reference has none", () => {
    const record = { ...sample_record, rules: { rule1: sample_record.rules.rule1 } };
    const reference_yaml = convert_theory(record);
    const plain: ExtractionTask = { id: record.id, english: record.theory, reference_yaml, reference: parse_rule_set(reference_yaml, record.id) };

    expect(plain.reference.relations.has("is_a")).toBe(false);
    expect(score_extraction(plain, faithful)).toMatchObject({ problem: "" });
  });
});

// ============================================================================
// bench-extract
// ============================================================================

describe("bench-extract", () => {
  async function source(records: unknown[]): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "extract-"));
    await writeFile(join(folder, "meta-test.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    return folder;
  }

  it("asks the command for every Nth theory and totals the scores", async () => {
    const broken = { ...sample_record, id: "Broken-1", triples: { triple1: { representation: `("cow" "is" "big" "-")` } } };
    const folder = await source([sample_record, broken, { ...sample_record, id: "RelNeg-CWA-D1-8" }, sample_record, { ...sample_record, id: "RelNeg-CWA-D1-9" }]);
    let asked = 0;
    const runner: ProgramRunner = async () => {
      asked++;
      return asked === 2 ? { exit_code: 1, stdout: "", stderr: "out of tokens\n" } : { exit_code: 0, stdout: faithful, stderr: "" };
    };
    const result = await run(["bench-extract", "--every", "2", "--jobs", "2", "meta-test.jsonl", "--", "model"], folder, runner);

    expect(asked).toBe(3);
    expect(result.out).toBe(
      [
        "RelNeg-CWA-D1-7: 4/4 answers",
        "RelNeg-CWA-D1-8: 0/4 answers (unusable: model failed: out of tokens)",
        "RelNeg-CWA-D1-9: 4/4 answers",
        "total: 8/12 answers, 2/3 theories fully right, 1 unusable",
        "",
      ].join("\n"),
    );
  });

  it("passes a grammar file for each theory with --grammar", async () => {
    const folder = await source([sample_record]);
    const seen: string[][] = [];
    const runner: ProgramRunner = async argv => {
      seen.push([...argv]);
      return { exit_code: 0, stdout: faithful, stderr: "" };
    };
    const result = await run(["bench-extract", "--grammar", "meta-test.jsonl", "--", "model", "-x"], folder, runner);

    expect(result.out).toContain("total: 4/4 answers");
    expect(seen[0].slice(0, 3)).toEqual(["model", "-x", "--grammar-file"]);
    expect(await readFile(seen[0][3], "utf8")).toContain('name ::= "bald_eagle"');
  });

  it("sends a refused reply back with its reason, up to --rounds tries", async () => {
    const folder = await source([sample_record, { ...sample_record, id: "RelNeg-CWA-D1-9" }]);
    const prompts: string[] = [];
    const broken = "rules:\n  - { id: R1, if: [not ?x is big], then: ?x is loud }\n";
    const runner: ProgramRunner = async (_argv, options) => {
      prompts.push(String(options.stdin));
      return { exit_code: 0, stdout: prompts.length === 2 ? faithful : broken, stderr: "" };
    };
    const result = await run(["bench-extract", "--every", "1", "--rounds", "2", "meta-test.jsonl", "--", "model"], folder, runner);

    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain("Your previous answer was refused:");
    expect(result.out.split("\n")[0]).toBe("RelNeg-CWA-D1-7: 4/4 answers (round 2)");
    expect(result.out.split("\n")[1]).toMatch(/^RelNeg-CWA-D1-9: 0\/4 answers \(round 2\) \(unusable: /);
  });

  it("needs a file, a command and whole numbers", async () => {
    const folder = await source([sample_record]);

    for (const args of [["meta-test.jsonl"], ["--every", "0", "meta-test.jsonl", "--", "m"], ["--jobs", "x", "meta-test.jsonl", "--", "m"], ["--rounds", "0", "meta-test.jsonl", "--", "m"], ["--", "m"]]) {
      expect((await run(["bench-extract", ...args], folder)).code).toBe(2);
    }
    expect((await run(["bench-extract", "meta-test.jsonl", "--", "m"], folder, async () => ({ exit_code: 0, stdout: faithful, stderr: "" }))).out).toContain("total: 4/4 answers, 1/1 theories fully right, 0 unusable");
  });
});
