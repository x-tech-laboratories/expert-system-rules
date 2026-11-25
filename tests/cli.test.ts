import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run_cli } from "../src/cli.ts";
import type { ProgramRunner } from "../src/runner.ts";

// ============================================================================
// Helpers
// ============================================================================

const rule_set_text = `
id: birds
title: Birds
license: CC-BY-SA-4.0
source: Test.
features:
  feathers: Feathers?
goals: [bird]
rules:
  - { id: R1, if: [feathers], then: bird }
cases:
  - { id: sparrow, note: Small., facts: [feathers], expect: [bird] }
  - { id: rock, facts: [], expect: [] }
`;

async function project(expect_line = "expect: [bird] }"): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "cli-"));
  await mkdir(join(folder, "rulesets", "animals"), { recursive: true });
  await writeFile(join(folder, "rulesets", "animals", "birds.yaml"), rule_set_text.replace("expect: [bird] }", expect_line));
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
// check, explain, rules, prompt
// ============================================================================

describe("run_cli", () => {
  it("checks every rule set under rulesets/", async () => {
    const result = await run(["check"], await project());

    expect(result).toEqual({ code: 0, out: "birds: 1 rules, 2/2 cases match the engine\n", err: "" });
  });

  it("fails a check whose expect disagrees with the engine", async () => {
    const result = await run(["check", "rulesets/animals/birds.yaml"], await project("expect: [] }"));

    expect(result.code).toBe(1);
    expect(result.out).toContain("sparrow: expect lists nothing extra, misses bird");
  });

  it("explains a case's goals, or named conclusions", async () => {
    const folder = await project();

    expect((await run(["explain", "rulesets/animals/birds.yaml", "sparrow"], folder)).out).toBe(
      "birds / sparrow: feathers\n  Small.\nbird holds by R1: IF feathers THEN bird\n  feathers: given\n",
    );
    expect((await run(["explain", "rulesets/animals/birds.yaml", "rock", "bird"], folder)).out).toContain("rock: (no facts)\nbird does not hold");
    expect(await run(["explain", "rulesets/animals/birds.yaml", "moon"], folder)).toMatchObject({ code: 2, err: `birds has no case "moon". Cases: sparrow, rock\n` });
  });

  it("prints the rules and the model prompt", async () => {
    const folder = await project();

    expect((await run(["rules", "rulesets/animals/birds.yaml"], folder)).out).toBe("R1: IF feathers THEN bird\n");
    expect((await run(["prompt", "rulesets/animals/birds.yaml"], folder)).out).toContain("sparrow: feathers");
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
// bench
// ============================================================================

describe("bench", () => {
  it("scores each run of the model's answer", async () => {
    const result = await run(["bench", "--runs", "2", "--", "model"], await project(), answer('{"sparrow": [], "rock": []}'));

    expect(result.out).toBe(
      [
        "birds run 1: 1/2 cells, 1/2 cases fully right",
        "  sparrow: missing bird; extra none",
        "birds run 2: 1/2 cells, 1/2 cases fully right",
        "  sparrow: missing bird; extra none",
        "total: 2/4 cells",
        "",
      ].join("\n"),
    );
  });

  it("counts an unusable answer as all wrong", async () => {
    const result = await run(["bench", "rulesets/animals/birds.yaml", "--", "model"], await project(), answer("I think so"));

    expect(result.out).toBe("birds run 1: no usable answer (the answer holds no JSON object)\ntotal: 0/2 cells\n");
  });

  it("needs a command and a sensible run count", async () => {
    const folder = await project();

    expect(await run(["bench"], folder)).toMatchObject({ code: 2, err: "bench needs a command after --, such as: -- claude -p --model haiku\n" });
    expect(await run(["bench", "--runs", "0", "--", "model"], folder)).toMatchObject({ code: 2, err: "--runs needs a whole number of 1 or more\n" });
  });
});
