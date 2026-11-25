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
- Rule sets are versioned modules named by their path, listed in a catalog of subjects and tags,
  sharing a core vocabulary mapped to Wikidata properties, importing each other (the shallow
  `core/upper` tree of kinds first), and recording each rule's source and how it was written.

## Next

1. **Provenance per fact.** Rules carry `source` and `method`; facts brought in from elsewhere need
   the same, down to the Wikidata item, statement id and snapshot date each one came from, so every
   conclusion can cite the statements behind it.
2. **An LLM drafting command.** `draft --source document.txt` asks a model for candidate rules, each
   with its citation and test cases, written as a new rule set for review in a pull request.
3. **Stronger checks in CI.** Rules that can never fire, conclusions nothing uses, two rule sets
   with the same id, and test cases that cover every rule at least once.
4. **Scopes.** Done as modules and imports (see [format.md](format.md#organising)). Still to come:
   importing only a rule set's conclusions rather than all its rules.
5. **Defaults and exceptions.** Done: `usually` rules give way to `not` conclusions (see
   [format.md](format.md#defaults-and-exceptions)). Still to come: preferring the more specific of two
   defaults that override each other for the same individual, and a `certainty` for rules that hold
   only some of the time.
6. **More collections.** ProofWriter is converted; ATOMIC, ConceptNet and OpenCyc follow, as planned in
   [porting.md](porting.md).
7. **Facts from Wikidata.** Triples already match Wikidata's statements and the core vocabulary names
   the matching properties. Wikidata holds facts, not rules or confidence: an importer should pull a
   narrow slice (through SPARQL or a dump) into a pinned local snapshot, since the public endpoint
   times out and its data changes, and keep the rules here. Coverage is uneven, so a missing
   statement must read as unknown, not false (item 10), and `not` should only read facts curated
   here. Qualifiers can carry relationships with more than two parts.
8. **Numbers.** Done for comparisons (`less_than`, `greater_than`, `at_most`, `at_least`,
   `equal_to`; see [format.md](format.md#numbers)). Still to come: arithmetic such as `plus`, dates,
   and units: Wikidata's quantities come with a unit (an item) and upper and lower bounds, so numbers
   need unit normalisation and ranges as well.
9. **Per-individual layering.** Done: rules that only loop through `not` for different individuals
   are layered triple by triple, which accepts all 15,275 closed-world ProofWriter test theories
   (71 were refused before) and lets opposite defaults apply to different kinds.
10. **An "unknown" answer.** Done: relations marked `world: open` (facts from Wikidata belong there)
   answer true, false or unknown, and `not` may not read them. Still to come: an open-world `bench`
   run, since models tend to answer false where the honest answer is unknown.

## Out of scope for now

A single hierarchy of everything. Upper ontologies have been tried for decades; small, scoped rule
sets that can be tested are more useful and can be connected later.
