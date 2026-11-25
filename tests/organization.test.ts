import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { infer, holds } from "../src/engine.ts";
import { catalog_problems, find_catalog, load_rule_set, module_name, parse_catalog, parse_rule_set, parse_vocabulary, RuleSetError, type Library, type RuleSet } from "../src/rule_set.ts";

// ============================================================================
// Helpers
// ============================================================================

const vocabulary = `
id: shared
title: Shared
version: 1.0.0
license: CC-BY-SA-4.0
source: Test.
relations:
  is_a: { meaning: Is an instance of., wikidata: P31 }
  subclass_of: { meaning: Is a subkind of., wikidata: P279 }
`;

const base = `
id: base
title: Base
version: 1.0.0
license: CC-BY-SA-4.0
source: Test.
vocabularies: [shared]
rules:
  - { id: B1, if: [?x is_a ?k, ?k subclass_of ?w], then: ?x is_a ?w }
facts:
  - dog subclass_of animal
`;

const user = `
id: pets
title: Pets
version: 2.1.0
license: CC-BY-SA-4.0
source: Test.
method: llm_drafted_human_reviewed
tags: [pets]
vocabularies: [shared]
imports: [core/base]
relations:
  owns: Has as a pet.
rules:
  - { id: P1, if: [?p owns ?x], then: ?x is_a pet, source: "Pets are owned.", method: hand_written, note: The simplest rule. }
cases:
  - { id: rex, facts: [ann owns rex, rex is_a dog], expect: [rex is_a animal, rex is_a pet], expect_not: [ann is_a pet] }
`;

function problems_of(action: () => unknown): string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof RuleSetError) return error.problems;
    throw error;
  }
  return [];
}

function library_with(rule_sets: Record<string, RuleSet> = {}): Library {
  const shared = parse_vocabulary(vocabulary, "shared.yaml");
  return { vocabulary: name => (name === "shared" ? shared : undefined), rule_set: name => rule_sets[name] };
}

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "esr-org-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const catalog = `
subjects:
  core: { description: The backbone., wikidata: Q35120 }
  pets: Animals people keep.
tags:
  pets: About pets.
`;

// ============================================================================
// Vocabularies
// ============================================================================

describe("parse_vocabulary", () => {
  it("reads relations with their Wikidata properties", () => {
    const shared = parse_vocabulary(vocabulary, "shared.yaml");

    expect(shared.relations.get("is_a")).toEqual({ meaning: "Is an instance of.", wikidata: "P31", from: "shared" });
    expect(shared.version).toBe("1.0.0");
  });

  it("refuses a bad property id, unknown fields and an empty list", () => {
    expect(problems_of(() => parse_vocabulary("id: v\ntitle: V\nversion: one\nlicense: X\nsource: Y\nextra: 1\nrelations:\n  is_a: { meaning: M, wikidata: Q5, label: L }", "v.yaml"))).toEqual([
      `the vocabulary has an unknown field "extra"; the fields are id, title, version, license, source, relations`,
      `"version" must be major.minor.patch, such as 1.0.0, not "one"`,
      `relation "is_a" has an unknown field "label"; the fields are meaning, wikidata`,
      `relation "is_a": "wikidata" must be a property id such as P31, not "Q5"`,
    ]);
    expect(problems_of(() => parse_vocabulary("id: v\ntitle: V\nversion: 1.0.0\nlicense: X\nsource: Y", "v.yaml"))).toEqual([`"relations" must list at least one relation`]);
  });
});

// ============================================================================
// Imports
// ============================================================================

describe("parse_rule_set with a library", () => {
  it("shares a vocabulary, imports facts and rules, and qualifies imported rule ids", () => {
    const library = library_with({ "core/base": parse_rule_set(base, "base.yaml", library_with()) });
    const pets = parse_rule_set(user, "pets.yaml", library);

    expect(pets.rules.map(rule => rule.id)).toEqual(["P1", "core/base:B1"]);
    expect(pets.rules[1]).toMatchObject({ from: "core/base", method: "hand_written" });
    expect(pets.rules[0]).toMatchObject({ source: "Pets are owned.", method: "hand_written", note: "The simplest rule." });
    expect(pets.method).toBe("llm_drafted_human_reviewed");
    expect(pets.relations.get("is_a")?.from).toBe("shared");
    expect(pets.relations.get("owns")?.from).toBe("");
    expect(pets.facts).toContainEqual({ subject: "dog", relation: "subclass_of", object: "animal" });

    const inference = infer(pets, pets.cases[0].facts);
    expect(holds(inference, { subject: "rex", relation: "is_a", object: "animal" })).toBe(true);
  });

  it("keeps an already-qualified rule as it is and takes each rule once", () => {
    const library = library_with({ "core/base": parse_rule_set(base, "base.yaml", library_with()) });
    const middle = parse_rule_set(base.replace("id: base", "id: middle").replace("B1", "M1").replace("vocabularies: [shared]", "vocabularies: [shared]\nimports: [core/base]"), "middle.yaml", library);
    const top = parse_rule_set(user.replace("imports: [core/base]", "imports: [core/base, core/middle]"), "top.yaml", library_with({ "core/base": library.rule_set("core/base")!, "core/middle": middle }));

    expect(top.rules.map(rule => rule.id)).toEqual(["P1", "core/base:B1", "core/middle:M1"]);
  });

  it("finds no vocabulary or import without a library, and needs a meaning", () => {
    expect(problems_of(() => parse_rule_set(user.replace("owns: Has as a pet.", "owns: { wikidata: P127 }"), "x.yaml"))).toEqual([
      `relation "owns" needs a meaning`,
      `no vocabulary named "shared"`,
      `no rule set named "core/base" to import`,
      `the relation "is_a" is used but not listed under "relations" or in a vocabulary`,
    ]);
  });

  it("refuses unknown vocabularies and imports, redefined relations and clashing meanings", () => {
    const clashing = parse_rule_set(base.replace("vocabularies: [shared]", "relations:\n  is_a: Something else.\n  subclass_of: Narrower."), "clash.yaml");

    expect(problems_of(() => parse_rule_set(user.replace("vocabularies: [shared]", "vocabularies: [shared, missing]").replace("owns: Has as a pet.", "owns: Has.\n  is_a: Mine."), "x.yaml", library_with()))).toEqual([
      `the relation "is_a" is already defined by vocabulary shared; remove it from "relations"`,
      `no vocabulary named "missing"`,
      `no rule set named "core/base" to import`,
    ]);
    expect(problems_of(() => parse_rule_set(user.replace("imports: [core/base]", "imports: [Core/Base, other]"), "x.yaml", library_with({ other: clashing })))).toEqual([
      `the import "Core/Base" must be a path under rulesets/ without ".yaml", such as core/upper`,
      `no rule set named "Core/Base" to import`,
      `the relation "is_a" means different things in shared and import other`,
      `the relation "subclass_of" means different things in shared and import other`,
    ]);
  });

  it("refuses unknown fields, a bad version or method, and a ':' in a rule id", () => {
    const text = user
      .replace("version: 2.1.0", "version: 2.1")
      .replace("method: llm_drafted_human_reviewed", "method: guessed\ncolour: blue")
      .replace("{ id: P1,", "{ id: 'P:1', when: now,").replace("method: hand_written,", "method: magic,")
      .replace("{ id: rex,", "{ id: rex, answer: 1,");

    expect(problems_of(() => parse_rule_set(text, "x.yaml", library_with({ "core/base": parse_rule_set(base, "base.yaml", library_with()) })))).toEqual([
      `the rule set has an unknown field "colour"; the fields are id, title, description, version, license, source, method, tags, vocabularies, imports, relations, facts, rules, cases`,
      `"version" must be major.minor.patch, such as 1.0.0, not "2.1"`,
      `"method" must be one of hand_written, llm_drafted, llm_drafted_human_reviewed, converted, not "guessed"`,
      `rule id "P:1" must not hold ":", which marks imported rules`,
      `rule P:1 has an unknown field "when"; the fields are id, if, then, source, method, note`,
      `rule P:1: "method" must be one of hand_written, llm_drafted, llm_drafted_human_reviewed, converted, not "magic"`,
      `case rex has an unknown field "answer"; the fields are id, note, facts, expect, expect_not`,
    ]);
  });
});

// ============================================================================
// Catalog and loading from files
// ============================================================================

describe("catalog", () => {
  it("reads subjects with optional Wikidata items, and tags", () => {
    const read = parse_catalog(catalog, "/repo");

    expect(read.subjects.get("core")).toEqual({ description: "The backbone.", wikidata: "Q35120" });
    expect(read.subjects.get("pets")).toEqual({ description: "Animals people keep.", wikidata: "" });
    expect(read.tags.get("pets")).toBe("About pets.");
  });

  it("refuses an empty or malformed catalog", () => {
    expect(problems_of(() => parse_catalog("subjects: {}\ntags: [a]\nother: 1", "/repo"))).toEqual([
      `the catalog has an unknown field "other"; the fields are subjects, tags`,
      `"subjects" must map each name to what it covers`,
      `"tags" must map each name to what it covers`,
    ]);
    expect(problems_of(() => parse_catalog("subjects: { a: { description: A, wikidata: P31, x: 1 }, b: '' }\ntags: { t: { description: T, y: 2 } }", "/repo"))).toEqual([
      `subject "a" has an unknown field "x"; the fields are description, wikidata`,
      `subject "a": "wikidata" must be an item id such as Q729, not "P31"`,
      `subject "b": "description" must be a non-empty string`,
      `tag "t" has an unknown field "y"; the fields are description`,
    ]);
  });

  it("names unlisted subjects and tags, ids that are not the file name, and files outside a subject", () => {
    const read = parse_catalog(catalog, "/repo");
    const rule_set = { id: "pets", tags: ["pets", "cats"] } as RuleSet;

    expect(module_name(read, "/repo/rulesets/pets/pets.yaml")).toBe("pets/pets");
    expect(catalog_problems(read, "/repo/rulesets/pets/pets.yaml", rule_set)).toEqual([`the tag "cats" is not listed under "tags" in catalog.yaml`]);
    expect(catalog_problems(read, "/repo/rulesets/birds/owls.yaml", { ...rule_set, tags: [] })).toEqual([
      `the subject folder "birds" is not listed under "subjects" in catalog.yaml`,
      `the id "pets" must match the file name "owls"`,
    ]);
    expect(catalog_problems(read, "/repo/rulesets/pets.yaml", { ...rule_set, tags: [] })).toEqual([`rule sets live in a subject folder under rulesets/, not at /repo/rulesets/pets.yaml`]);
  });

  it("loads vocabularies and imports through the catalog's root", async () => {
    const root = await repository({
      "catalog.yaml": catalog,
      "vocabularies/shared.yaml": vocabulary,
      "rulesets/core/base.yaml": base,
      "rulesets/pets/pets.yaml": user,
    });

    expect((await find_catalog(join(root, "rulesets/pets/pets.yaml")))?.root).toBe(root);
    const pets = await load_rule_set(join(root, "rulesets/pets/pets.yaml"));
    expect(pets.rules.map(rule => rule.id)).toEqual(["P1", "core/base:B1"]);
  });

  it("refuses imports that loop, and names what is missing", async () => {
    const root = await repository({
      "catalog.yaml": catalog,
      "vocabularies/shared.yaml": vocabulary,
      "rulesets/core/base.yaml": base.replace("vocabularies: [shared]", "vocabularies: [shared]\nimports: [pets/pets]"),
      "rulesets/pets/pets.yaml": user,
      "rulesets/pets/lonely.yaml": user.replace("imports: [core/base]", "imports: [pets/none, '../x']").replace("[shared]", "[nothing]"),
      "rulesets/pets/broken.yaml": "id: [unclosed",
    });

    await expect(load_rule_set(join(root, "rulesets/pets/pets.yaml"))).rejects.toThrow("the imports loop: rulesets/pets/pets.yaml -> rulesets/core/base.yaml -> rulesets/pets/pets.yaml");
    await expect(load_rule_set(join(root, "rulesets/pets/lonely.yaml"))).rejects.toThrow(`no rule set named "pets/none" to import`);
    await expect(load_rule_set(join(root, "rulesets/pets/broken.yaml"))).rejects.toThrow("not valid YAML");
  });

  it("loads a rule set without a catalog on its own", async () => {
    const root = await mkdtemp(join(tmpdir(), "esr-alone-"));
    await writeFile(join(root, "base.yaml"), base.replace("vocabularies: [shared]", "relations:\n  is_a: I.\n  subclass_of: S."));

    expect(await find_catalog(join(root, "base.yaml"))).toBeNull();
    expect((await load_rule_set(join(root, "base.yaml"))).id).toBe("base");
  });
});
