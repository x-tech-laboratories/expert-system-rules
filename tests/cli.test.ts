import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run_cli } from "../src/cli.ts";
import type { ProofWriterRecord } from "../src/importers/proofwriter.ts";
import { sample_record } from "./fixtures/proofwriter.ts";
import type { ProgramRunner } from "../src/runner.ts";

// ============================================================================
// Helpers
// ============================================================================

const rule_set_text = `
id: birds
title: Birds
license: CC-BY-SA-4.0
source: Test.
relations:
  has: Has.
  is: Is.
  in: Inside.
rules:
  - { id: R1, if: [?x has feathers], then: ?x is bird }
  - { id: R2, if: [?x in ?y, ?y in ?z], then: ?x in ?z }
facts:
  - nest in tree
cases:
  - { id: sparrow, note: Small., facts: [sparrow has feathers, sparrow in nest], expect: [sparrow is bird] }
  - { id: rock, expect_not: [rock is bird] }
`;

const birds = "rulesets/animals/birds.yaml";

async function project(text = rule_set_text): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "cli-"));
  await mkdir(join(folder, "rulesets", "animals"), { recursive: true });
  await writeFile(join(folder, birds), text);
  return folder;
}

async function run(args: string[], cwd: string, runner?: ProgramRunner) {
  let out = "";
  let err = "";
  const code = await run_cli(args, { cwd, out: { write: text => void (out += text) }, err: { write: text => void (err += text) }, run: runner });
  return { code, out, err };
}

const answer = (stdout: string): ProgramRunner => async () => ({ exit_code: 0, stdout, stderr: "" });

// ============================================================================
// check, explain, query, rules, prompt
// ============================================================================

describe("run_cli", () => {
  it("checks every rule set under rulesets/", async () => {
    const result = await run(["check"], await project());

    expect(result).toEqual({ code: 0, out: "birds: 2 rules, 1 facts, 2/2 cases match the engine\n", err: "" });
  });

  it("takes an absolute path to a rule set anywhere", async () => {
    const folder = await project();

    expect((await run(["check", join(folder, birds)], "/")).out).toBe("birds: 2 rules, 1 facts, 2/2 cases match the engine\n");
  });

  it("fails a check whose written answers disagree with the engine", async () => {
    const result = await run(["check", birds], await project(rule_set_text.replace("expect_not: [rock is bird]", "expect: [rock is bird]")));

    expect(result.code).toBe(1);
    expect(result.out).toContain(`  rock: "rock is bird" is false by the engine, the case says true`);
  });

  it("explains a case's questions, or the triples given", async () => {
    const folder = await project();

    expect((await run(["explain", birds, "sparrow"], folder)).out).toBe(
      "birds / sparrow: sparrow has feathers; sparrow in nest\n  Small.\nsparrow is bird holds by R1: IF ?x has feathers THEN ?x is bird\n  sparrow has feathers: given\n",
    );
    expect((await run(["explain", birds, "rock", "rock in tree"], folder)).out).toContain("rock: (no facts)\nrock in tree does not hold");
    expect(await run(["explain", birds, "moon"], folder)).toMatchObject({ code: 1, err: `birds has no case "moon". Cases: sparrow, rock\n` });
  });

  it("answers a query with every match", async () => {
    const folder = await project();

    expect((await run(["query", birds, "sparrow", "sparrow in ?where"], folder)).out).toBe("?where = nest\n?where = tree\n");
    expect((await run(["query", birds, "sparrow", "sparrow is bird"], folder)).out).toBe("holds\n");
    expect((await run(["query", birds, "rock", "?x is bird"], folder)).out).toBe("no matches\n");
  });

  it("prints the rules and the model prompt", async () => {
    const folder = await project();

    expect((await run(["rules", birds], folder)).out).toBe("R1: IF ?x has feathers THEN ?x is bird\nR2: IF ?x in ?y AND ?y in ?z THEN ?x in ?z\n");
    expect((await run(["prompt", birds], folder)).out).toContain("sparrow: facts: sparrow has feathers");
  });

  it("prints usage for help and for a wrong command", async () => {
    expect((await run([], "/")).out).toContain("Usage:");
    expect(await run(["frobnicate"], "/")).toMatchObject({ code: 2 });
    expect(await run(["prompt"], "/")).toMatchObject({ code: 2 });
  });

  it("reports an unreadable rule set", async () => {
    const result = await run(["check", "missing.yaml"], await project());

    expect(result.code).toBe(1);
    expect(result.err).toContain("ENOENT");
  });
});

// ============================================================================
// import-proofwriter
// ============================================================================

describe("import-proofwriter", () => {
  const looping: ProofWriterRecord = {
    ...sample_record,
    id: "AttNeg-CWA-D1-9",
    rules: { rule1: { representation: `((("someone" "is" "big" "+") ("someone" "is" "red" "~")) -> ("someone" "is" "red" "+"))` } },
  };
  const disagreeing: ProofWriterRecord = {
    ...sample_record,
    id: "RelNeg-CWA-D1-8",
    questions: { Q1: { question: "The cow is big.", answer: true, representation: `("cow" "is" "big" "+")` } },
  };

  async function source(records: ProofWriterRecord[]): Promise<string> {
    const folder = await mkdtemp(join(tmpdir(), "proofwriter-"));
    await writeFile(join(folder, "meta-test.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    return folder;
  }

  it("converts, checks and writes every Nth theory", async () => {
    const folder = await source([sample_record, { ...sample_record, id: "RelNeg-CWA-D1-9" }]);
    const result = await run(["import-proofwriter", "meta-test.jsonl", "out", "--every", "2"], folder);

    expect(result.code).toBe(0);
    expect(result.out).toBe(
      `2 theories: 2 fully reproduced, 0 with different answers, 0 refused\n8/8 answers match ProofWriter\nwrote 1 rule sets to ${join(folder, "out")}\n`,
    );
    expect(await readdir(join(folder, "out"))).toEqual(["relneg-cwa-d1-7.yaml"]);
  });

  it("reports theories it refuses and answers it disagrees with", async () => {
    const result = await run(["import-proofwriter", "meta-test.jsonl", "out"], await source([looping, disagreeing]));

    expect(result.code).toBe(1);
    expect(result.out).toContain("2 theories: 0 fully reproduced, 1 with different answers, 1 refused");
    expect(result.out).toContain("  RelNeg-CWA-D1-8: the engine disagrees with 1 of ProofWriter's 1 answers");
    expect(result.out).toContain("  AttNeg-CWA-D1-9: a conclusion depends on its own negation, so the rules have no single answer");
  });

  it("reports a theory that does not convert", async () => {
    const broken = { ...sample_record, id: "Broken-1", triples: { triple1: { representation: `("cow" "is" "big" "-")` } } };
    const result = await run(["import-proofwriter", "meta-test.jsonl", "out"], await source([broken]));

    expect(result.out).toContain("  Broken-1: Broken-1 triple1: only positive facts can be converted");
  });

  it("needs a source, a folder and a sensible --every", async () => {
    expect(await run(["import-proofwriter", "only-one"], "/")).toMatchObject({ code: 2 });
    expect(await run(["import-proofwriter", "a", "b", "--every", "0"], "/")).toMatchObject({ code: 2, err: "--every needs a whole number of 1 or more\n" });
  });
});

// ============================================================================
// bench
// ============================================================================

describe("bench", () => {
  it("scores each run of the model's answer", async () => {
    const result = await run(["bench", "--runs", "2", "--", "model"], await project(), answer('{"sparrow": [false], "rock": [false]}'));

    expect(result.out).toBe(
      [
        "birds run 1: 1/2 questions, 1/2 cases fully right",
        `  sparrow: "sparrow is bird" is true by the engine, the model said false`,
        "birds run 2: 1/2 questions, 1/2 cases fully right",
        `  sparrow: "sparrow is bird" is true by the engine, the model said false`,
        "total: 2/4 questions",
        "",
      ].join("\n"),
    );
  });

  it("counts an unusable answer as all wrong", async () => {
    const result = await run(["bench", birds, "--", "model"], await project(), answer("I think so"));

    expect(result.out).toBe("birds run 1: no usable answer (the answer holds no JSON object)\ntotal: 0/2 questions\n");
  });

  it("reports a question left unanswered", async () => {
    const result = await run(["bench", "--", "model"], await project(), answer('{"sparrow": [true]}'));

    expect(result.out).toContain(`  rock: "rock is bird" is false by the engine, the model said no answer`);
  });

  it("needs a command and a sensible run count", async () => {
    const folder = await project();

    expect(await run(["bench"], folder)).toMatchObject({ code: 2, err: "bench needs a command after --, such as: -- claude -p --model haiku\n" });
    expect(await run(["bench", "--runs", "0", "--", "model"], folder)).toMatchObject({ code: 2, err: "--runs needs a whole number of 1 or more\n" });
  });
});
