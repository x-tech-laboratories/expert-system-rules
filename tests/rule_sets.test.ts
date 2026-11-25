import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { catalog_problems, find_catalog, list_rule_set_files, load_rule_set } from "../src/rule_set.ts";
import { check_cases, is_correct } from "../src/runner.ts";

// ============================================================================
// Every shipped rule set
// ============================================================================

const files = await list_rule_set_files(join(import.meta.dirname, "..", "rulesets"));

describe("shipped rule sets", () => {
  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s loads and every case matches the engine", async file => {
    const rule_set = await load_rule_set(file);

    expect(check_cases(rule_set).filter(result => !is_correct(result))).toEqual([]);
    expect(rule_set.cases.length).toBeGreaterThan(0);
    expect(catalog_problems((await find_catalog(file))!, file, rule_set)).toEqual([]);
  });
});
