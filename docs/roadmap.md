# Roadmap

The aim is an open, community-contributed body of rules for expert systems, largely drafted by
language models and never merged without checks and a human review. Generating rules is the easy
part; the work is in verifying, scoping and governing them.

## Where it stands

- One YAML format of facts as `subject relation object` triples and rules that join them through
  `?variables`, a layered engine with explanations and queries, and a checker that refuses unknown
  names, unbound variables and conclusions that depend on their own negation.
- Every rule set carries test cases, and CI fails when a case disagrees with the engine.
- A runner that scores any command-line model against the engine.

## Next

1. **Provenance per rule.** An optional `source` on each rule (a citation or the quoted passage it
   came from) and a `method` such as `hand_written`, `llm_drafted` or `llm_drafted_human_reviewed`.
2. **An LLM drafting command.** `draft --source document.txt` asks a model for candidate rules, each
   with its citation and test cases, written as a new rule set for review in a pull request.
3. **Stronger checks in CI.** Rules that can never fire, conclusions nothing uses, two rule sets
   with the same id, and test cases that cover every rule at least once.
4. **Scopes.** Rule sets stay closed worlds, one per file, so a rule true in one scope cannot clash
   with another. Folders by subject and `tags` group them; a rule set can later import another's
   conclusions by id when sharing is needed.
5. **Defaults and exceptions.** Many real rules hold "unless" something; today that is written with
   `not`. A `certainty` or `default` marker may follow if real rule sets need it.
6. **More collections.** Converters for the sources in [sources.md](sources.md), starting with a
   ProofWriter subset, since it brings correct answers to score models against.
7. **Facts from Wikidata.** Triples already match Wikidata's statements; an importer can bring in
   reference facts for rule sets to reason over, and qualifiers can carry relationships with more
   than two parts.
8. **Numbers.** The common-sense rule sets compare and order things without arithmetic. Built-in
   relations such as `less_than` and `plus` would let rules work with real quantities, dates and
   unit conversions.
9. **An "unknown" answer.** General knowledge is an open world: what is not concluded is often not
   false but unknown. A three-valued mode would answer true, false or unknown.

## Out of scope for now

A single hierarchy of everything. Upper ontologies have been tried for decades; small, scoped rule
sets that can be tested are more useful and can be connected later.
