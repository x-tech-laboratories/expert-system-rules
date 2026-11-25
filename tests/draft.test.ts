import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { run_cli } from "../src/cli.ts";
import { check_draft, draft_prompt, quote_problems, type DraftRequest } from "../src/draft.ts";
import { parse_catalog, parse_rule_set, parse_vocabulary } from "../src/rule_set.ts";
import type { ProgramRunner } from "../src/runner.ts";

// ============================================================================
// Helpers
// ============================================================================

const source_text = "Milk should be kept cold. Milk left out for more than two hours should be thrown away.\nBread may be kept at room temperature.";

const catalog_text = "subjects:\n  food: Food.\ntags:\n  food-safety: Food safety.\n  negation: Uses not.\n";

const vocabulary_text = `
id: core
title: Core
version: 1.0.0
license: CC-BY-SA-4.0
source: Test.
relations:
  is_a: { meaning: Is an instance of., wikidata: P31 }
`;

const good = `
id: milk
title: Milk
version: 1.0.0
license: CC-BY-SA-4.0
source: "Test text."
method: llm_drafted
tags: [food-safety]
vocabularies: [core]
relations:
  hours_out: Has been left out this many hours.
  should_be: Should be handled this way.
rules:
  - { id: R1, if: [?f is_a milk, ?f hours_out ?h, ?h greater_than 2], then: ?f should_be thrown_away, source: "Milk left out for more than  two hours should be thrown away." }
  - { id: R2, if: [?f is_a milk], then: ?f should_be kept_cold, source: "milk should be kept cold" }
cases:
  - { id: c1, facts: [m is_a milk, m hours_out 3], expect: [m should_be thrown_away, m should_be kept_cold] }
  - { id: c2, facts: [m is_a milk, m hours_out 2], expect_not: [m should_be thrown_away] }
  - { id: c3, facts: [b is_a bread, b hours_out 5], expect_not: [b should_be thrown_away, b should_be kept_cold] }
  - { id: c4, facts: [m is_a milk], expect: [m should_be kept_cold] }
`;

const request: DraftRequest = { source_text, id: "milk", subject: "food", license: "CC-BY-SA-4.0", cite: "Test text." };

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "draft-"));
  await writeFile(join(root, "catalog.yaml"), catalog_text);
  await mkdir(join(root, "vocabularies"));
  await writeFile(join(root, "vocabularies", "core.yaml"), vocabulary_text);
  await writeFile(join(root, "source.txt"), source_text);
  return root;
}

async function run(args: string[], cwd: string, runner?: ProgramRunner) {
  let out = "";
  let err = "";
  const code = await run_cli(args, { cwd, out: { write: text => void (out += text) }, err: { write: text => void (err += text) }, run: runner });
  return { code, out, err };
}

const replies = (...texts: string[]): { runner: ProgramRunner; prompts: string[] } => {
  const prompts: string[] = [];
  const runner: ProgramRunner = async (_argv, options) => {
    prompts.push(String(options.stdin));
    return { exit_code: 0, stdout: texts[prompts.length - 1], stderr: "" };
  };
  return { runner, prompts };
};

const draft_args = ["draft", "--source", "source.txt", "--id", "milk", "--subject", "food", "--cite", "Test text.", "--", "model"];

// ============================================================================
// Prompt and checks
// ============================================================================

describe("draft checks", () => {
  const catalog = parse_catalog(catalog_text, "/repo");

  it("prompts with the text, the fixed fields, the tags and the shared relations, and the problems on a retry", () => {
    const core = parse_vocabulary(vocabulary_text, "core.yaml");
    const first = draft_prompt(request, catalog, core);

    expect(first).toContain(source_text);
    expect(first).toContain("  id: milk");
    expect(first).toContain('  source: "Test text."');
    expect(first).toContain("tags: a few of: food-safety, negation");
    expect(first).toContain("is_a (Is an instance of.)");
    expect(first).not.toContain("previous draft");
    const again = draft_prompt(request, catalog, undefined, { yaml: "id: milk", problems: ["rule R1 needs a source"] });
    expect(again).toContain("- rule R1 needs a source");
    expect(again).not.toContain("vocabularies: [core]");
  });

  it("needs every rule to quote the text word for word", () => {
    const rule_set = parse_rule_set(good.replace("vocabularies: [core]", "relations_note: x").replace("relations_note: x\n", "").replace("relations:", "relations:\n  is_a: Is."), "milk.yaml");

    expect(quote_problems(rule_set, source_text)).toEqual([]);
    const made_up = parse_rule_set(good.replace("vocabularies: [core]\n", "").replace("relations:", "relations:\n  is_a: Is.").replace('source: "milk should be kept cold"', 'source: "Milk must be frozen."').replace(', source: "Milk left out for more than  two hours should be thrown away."', ""), "milk.yaml");
    expect(quote_problems(made_up, source_text)).toEqual([`rule R1 needs "source": a quote from the text that states it`, `rule R2: the quote "Milk must be frozen." is not in the source text word for word`]);
  });

  it("accepts a good draft and lists everything wrong with a bad one", async () => {
    const root = await repository();
    const path = join(root, "rulesets", "food", "milk.yaml");
    const real = parse_catalog(catalog_text, root);

    expect((await check_draft(good, path, request, real)).problems).toEqual([]);
    const bad = good
      .replace("license: CC-BY-SA-4.0", "license: MIT")
      .replace("method: llm_drafted", "method: hand_written")
      .replace("tags: [food-safety]", "tags: [dairy]")
      .replace("  - { id: c4, facts: [m is_a milk], expect: [m should_be kept_cold] }\n", "")
      .replace("expect_not: [m should_be thrown_away] }", "expect: [m should_be thrown_away] }")
      .replace("{ id: R2, if: [?f is_a milk], then: ?f should_be kept_cold", "{ id: R2, if: [?f is_a milk], then: ?f stays cold")
      .replace("  should_be: Should be handled this way.", "  should_be: Should be handled this way.\n  stays: Stays.")
      .replace("m should_be kept_cold] }", "m should_be thrown_away] }")
      .replace("b should_be kept_cold]", "b is_a milk]");
    expect((await check_draft(bad, path, request, real)).problems).toEqual([
      `the tag "dairy" is not listed under "tags" in catalog.yaml`,
      `"license" must be CC-BY-SA-4.0`,
      `"method" must be llm_drafted`,
      "write at least four cases",
      `no case asks about "stays", which rule R2 concludes`,
      `case c2: "m should_be thrown_away" is false by the rules, but the case says true`,
    ]);
    expect((await check_draft("rules: nope", path, request, real)).problems).toContain(`"rules" must be a non-empty list`);
    await mkdir(join(root, "vocabularies", "broken.yaml"));
    expect((await check_draft(good.replace("vocabularies: [core]", "vocabularies: [broken]"), path, request, real)).problems[0]).toMatch(/EISDIR/);
  });

  it("reports a conflict the draft's rules reach", async () => {
    const root = await repository();
    const clash = good.replace("then: ?f should_be kept_cold, source", "then: not ?f should_be thrown_away, source");
    const result = await check_draft(clash.replace("expect: [m should_be thrown_away, m should_be kept_cold]", "expect: [m should_be thrown_away]").replace("expect: [m should_be kept_cold]", "expect_not: [m should_be thrown_away]"), join(root, "rulesets", "food", "milk.yaml"), request, parse_catalog(catalog_text, root));

    expect(result.problems).toEqual([`case c1: "m should_be thrown_away" is concluded both to hold and to be false`]);
  });
});

// ============================================================================
// The command
// ============================================================================

describe("draft command", () => {
  it("writes a draft the checks accept", async () => {
    const root = await repository();
    const { runner, prompts } = replies("```yaml\n" + good + "```");
    const result = await run(draft_args, root, runner);

    expect(result.code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(result.out).toContain("round 1: accepted, 2 rules and 4 cases");
    expect(await readFile(join(root, "rulesets", "food", "milk.yaml"), "utf8")).toBe(good.trim() + "\n");
  });

  it("sends the problems back and accepts the fixed draft", async () => {
    const root = await repository();
    const { runner, prompts } = replies(good.replace("method: llm_drafted", "method: hand_written"), good);
    const result = await run(draft_args, root, runner);

    expect(result.out).toContain(`round 1: 1 problems\n  "method" must be llm_drafted\nround 2: accepted`);
    expect(prompts[1]).toContain(`- "method" must be llm_drafted`);
  });

  it("keeps the last refused draft outside rulesets/ with its problems", async () => {
    const root = await repository();
    const { runner } = replies("rules: nope", "rules: nope");
    const result = await run([...draft_args.slice(0, -2), "--rounds", "2", "--", "model"], root, runner);

    expect(result.code).toBe(1);
    expect(result.out).toContain(`not accepted after 2 rounds; the last draft and its problems are in ${join(root, "milk.rejected.yaml")}`);
    expect(await readFile(join(root, "milk.rejected.yaml"), "utf8")).toMatch(/^# "id" must be a non-empty string\n/);
  });

  it("needs its options, a listed subject and a catalog", async () => {
    const root = await repository();

    expect((await run(["draft", "--source", "source.txt", "--", "model"], root)).code).toBe(2);
    expect((await run(draft_args.slice(0, -2), root)).code).toBe(2);
    expect((await run([...draft_args.slice(0, -2), "--rounds", "0", "--", "model"], root)).code).toBe(2);
    expect((await run(draft_args.map(arg => (arg === "food" ? "drinks" : arg)), root)).err).toBe(`the subject "drinks" is not listed in catalog.yaml; add it there first\n`);
    const bare = await mkdtemp(join(tmpdir(), "draft-bare-"));
    expect((await run(draft_args, bare)).err).toMatch(/^no catalog.yaml above/);
  });
});
