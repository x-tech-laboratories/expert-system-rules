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
| [Creature licensing](rulesets/fiction/creatures.yaml) | fiction | 17 | 10 | fictional licensing, built to catch real-world priors |
| [Car won't start](rulesets/vehicles/car-wont-start.yaml) | vehicles | 16 | 9 | diagnosis |

One file holds one rule set: its features, rules and cases belong together, since a negated
condition reads the whole set. Files sit in a folder per subject, and `tags` in each file mark the
other ways to slice them. The format is described in [docs/format.md](docs/format.md), and larger
collections elsewhere are listed in [docs/sources.md](docs/sources.md), and where the project is going in [docs/roadmap.md](docs/roadmap.md).

A small example:

```yaml
id: birds
title: Birds
license: CC-BY-SA-4.0
source: Original to this repository.
tags: [classification]
features:
  feathers: Does it have feathers?
  heavy: Is it heavy?
goals: [flier]
rules:
  - { id: R1, if: [feathers], then: bird }
  - { id: R2, if: [bird, not heavy], then: flier }
cases:
  - { id: sparrow, facts: [feathers], expect: [bird, flier] }
```

## Using it

Node 24 or newer.

```sh
npm install
npm run check                                     # validate every rule set and run its cases
npm run explain -- rulesets/fiction/creatures.yaml penguin exportable
npm run prompt -- rulesets/fiction/creatures.yaml # the prompt a model is given
npm run bench -- --runs 3 -- claude -p --model haiku
```

`bench` sends each rule set's prompt to any command on its standard input and reads a JSON answer
from its output, so it works with any model that has a command line, such as `claude -p`,
`llm`, or `ollama run <model>`. Every conclusion of every case is one cell, right or wrong.

## Contributing a rule set

Add a YAML file under the subject's folder in `rulesets/`, with test cases whose `expect` lists
every conclusion that holds, and run `npm run check`. The tests fail if a rule set does not load or
a case disagrees with the engine. Say in `source` where the rules come from, and in `license` what
they are licensed under.

## License

- **Rule sets** in `rulesets/` are licensed under
  [Creative Commons Attribution-ShareAlike 4.0 International](LICENSES/CC-BY-SA-4.0.txt)
  (`CC-BY-SA-4.0`), unless the file's own `license` field names another licence.
- **Some rule sets are adapted from, or describe, other people's work and may carry other licences
  or attribution requirements.** Each file's `license` and `source` fields say which; check them
  before reusing a rule set on its own.
- **Code** (`src/`, `tests/`) is licensed under the GNU General Public License, version 3 or (at your
  option) any later version (`GPL-3.0-or-later`); see [LICENSE](LICENSE).

The rule sets are illustrative. They are not professional, medical, legal or mechanical advice.
