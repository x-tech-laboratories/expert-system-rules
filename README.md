# Expert system rules

A collection of expert system rule sets in plain YAML, an engine that runs them, and a runner that
asks AI models the same questions and scores their answers against the engine.

Rule-based systems reason by the letter: every conclusion follows from a rule, and every answer can
be explained down to the facts it came from. Language models reason by pattern. This repository
makes the difference measurable: each rule set carries test cases, some of them traps where the
rules contradict real-world knowledge, and the runner counts where a model and the engine part.

## Rule sets

| Rule set | Folder | Rules | Cases | Kind |
| --- | --- | --- | --- | --- |
| [Animal identification](rulesets/animals/animal-identification.yaml) | animals | 15 | 11 | classification, adapted from a textbook example |
| [Upper kinds](rulesets/core/upper.yaml) | core | 2 | 2 | the shallow tree of kinds other rule sets import |
| [Kitchen common sense](rulesets/commonsense/kitchen.yaml) | commonsense | 7 (+2 imported) | 5 | kinds of food, where things are, what spoils |
| [Typical and exceptional](rulesets/commonsense/typical.yaml) | commonsense | 7 (+2 imported) | 6 | defaults and exceptions, open-world unknowns |
| [Everyday physics](rulesets/commonsense/physics.yaml) | commonsense | 13 | 8 | support and falling, breaking, floating, melting, heat, fire |
| [People, needs and manners](rulesets/commonsense/people.yaml) | commonsense | 11 | 7 | needs, wants, feelings, thanks, loans, safety |
| [Sizes, weights and units](rulesets/commonsense/quantities.yaml) | commonsense | 11 | 8 | size classes, bigger and heavier, what fits, comparable units, numbers |
| [Everyday routines](rulesets/commonsense/routines.yaml) | commonsense | 5 | 7 | restaurant, fast food, doctor and train scripts |
| [Time and order](rulesets/commonsense/time.yaml) | commonsense | 11 | 7 | days of the week, past and future, during, ages, impossible timelines |
| [ProofWriter sample](rulesets/benchmarks/proofwriter-cwa-d5/) | benchmarks | 50 theories | 50 | generated reasoning puzzles with correct answers, converted from ProofWriter |
| [Creature licensing](rulesets/fiction/creatures.yaml) | fiction | 17 | 11 | fictional licensing, built to catch real-world priors |
| [Car won't start](rulesets/vehicles/car-wont-start.yaml) | vehicles | 16 | 9 | diagnosis |

Facts are triples, `subject relation object`, the same shape as a Wikidata statement, and rules
join them through `?variables`, so a rule set can describe many things and how they relate. One
file holds one rule set: its relations, facts, rules and cases belong together, since a `not`
condition reads the whole set. Files sit in a folder per subject, and `tags` in each file mark the
other ways to slice them. Rule sets can share the relations of a vocabulary such as
[vocabularies/core.yaml](vocabularies/core.yaml), whose relations map to Wikidata properties, and
import other rule sets, such as the tree of kinds in `core/upper`. [catalog.yaml](catalog.yaml) lists
the subject folders and tags. The format is described in [docs/format.md](docs/format.md), larger
collections elsewhere are listed in [docs/sources.md](docs/sources.md), plans for porting them
are in [docs/porting.md](docs/porting.md), how models score is in
[docs/benchmarks.md](docs/benchmarks.md), and where the project is going is in
[docs/roadmap.md](docs/roadmap.md).

A small example:

```yaml
id: birds
title: Birds
license: CC-BY-SA-4.0
source: Original to this repository.
tags: [classification]
relations:
  is_a: The subject is an instance of this kind.
  subclass_of: Every instance of the subject kind is also of this kind.
  is: The subject has this property.
rules:
  - { id: R1, if: [?x is_a ?kind, ?kind subclass_of ?wider], then: ?x is_a ?wider }
  - { id: R2, if: [?x is_a bird, not ?x is heavy], then: ?x is flier }
facts:
  - penguin subclass_of bird
cases:
  - id: pingu
    facts: [pingu is_a penguin]
    expect: [pingu is_a bird, pingu is flier]
```

## Using it

Node 24 or newer.

```sh
npm install
npm run check                                     # validate every rule set and run its cases
npm run explain -- rulesets/fiction/creatures.yaml penguin "penguin is exportable"
npm run query -- rulesets/commonsense/kitchen.yaml cooler_on_counter "cheese in ?where"
npm run prompt -- rulesets/fiction/creatures.yaml # the prompt a model is given
npm run import-proofwriter -- CWA/depth-5/meta-test.jsonl out/   # convert ProofWriter theories
npm run bench -- --runs 3 -- claude -p --model haiku
npm run bench-extract -- --jobs 4 CWA/depth-5/meta-test.jsonl -- claude -p --model haiku
npm run draft -- --source article.txt --id food-danger-zone --subject practical --cite "..." -- claude -p --model sonnet
```

`bench` sends each rule set's prompt to any command on its standard input and reads a JSON answer
from its output, so it works with any model that has a command line, such as `claude -p`,
`llm`, or `ollama run <model>`. Each case's questions are true/false (or unknown, for open-world
relations), one point each.

`bench-extract` tests the harder half: a model is given a ProofWriter theory's English, its relations
and names, writes the facts and rules itself, and is scored by how the engine then answers the
theory's questions. It measures how well a model could draft rule sets. Results are in
[docs/benchmarks.md](docs/benchmarks.md).

`draft` asks a model for a whole rule set from a source text. The draft must load, fit the catalog,
agree with its own cases, cover every rule with a case, and quote the source word for word in every
rule's `source`; whatever fails goes back to the model, for up to three rounds. An accepted draft is
written to `rulesets/<subject>/` with `method: llm_drafted`, for a person to review against the quotes
before it is merged: the checks catch broken drafts, not incomplete or unscoped ones.

## Contributing a rule set

Add a YAML file named after its `id` under the subject's folder in `rulesets/`, with test cases
that list what must hold under `expect` and what must not under `expect_not`, and run
`npm run check`. The tests fail if a rule set does not load, a case disagrees with the engine, or
its folder or tags are not in [catalog.yaml](catalog.yaml). Say in `source` where the rules come
from, in `license` what they are licensed under, and in `method` how they were written. Use the
core vocabulary's relations where they fit rather than defining your own.

## License

- **Rule sets** in `rulesets/`, the vocabularies in `vocabularies/` and `catalog.yaml` are licensed under
  [Creative Commons Attribution-ShareAlike 4.0 International](LICENSES/CC-BY-SA-4.0.txt)
  (`CC-BY-SA-4.0`), unless the file's own `license` field names another licence.
- **Some rule sets are adapted from, or describe, other people's work and may carry other licences
  or attribution requirements.** Each file's `license` and `source` fields say which; check them
  before reusing a rule set on its own.
- **Code** (`src/`, `tests/`) is licensed under the GNU General Public License, version 3 or (at your
  option) any later version (`GPL-3.0-or-later`); see [LICENSE](LICENSE).

The rule sets are illustrative. They are not professional, medical, legal or mechanical advice.
