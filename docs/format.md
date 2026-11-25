# Rule set format

A rule set is one YAML file. Everything in it is checked when it loads: unknown names, cases that
give facts no feature describes, and conclusions that depend on their own negation are all refused
with a message naming the problem.

| Field | Required | Holds |
| --- | --- | --- |
| `id` | yes | A short name, usually the file name |
| `title` | yes | A human name |
| `description` | no | What the rule set is about and what it tests |
| `license` | yes | An SPDX identifier, `CC-BY-SA-4.0` for rule sets written here |
| `source` | yes | Where the rules come from, with attribution when adapted |
| `tags` | no | Labels such as `classification`, `diagnosis`, `negation`, `trap-cases`, `original`, `adapted` |
| `features` | yes | Each observable fact and the question that asks for it |
| `goals` | no | The conclusions a consultation sets out to decide |
| `rules` | yes | The rules, each with `id`, `if` and `then` |
| `cases` | no | Test cases, each with `id`, `facts`, `expect` and an optional `note` |

## Features and conclusions

Names are `lower_snake_case`. A **feature** is something you observe and give; a **conclusion** is
anything a rule's `then` names. A name is one or the other, never both: a rule cannot conclude a
feature, and a case cannot give a conclusion.

## Rules

```yaml
- { id: R6, if: [bird, not grounded], then: flier }
```

All conditions in `if` must hold. `not x` holds when `x` cannot be concluded from the given facts
and the rules (a closed world). Two rules with the same `then` are alternatives: either one is
enough.

The engine settles conclusions in layers, so `not x` is only read once everything that could
conclude `x` has run. A rule set where a conclusion depends on its own negation, directly or
through a chain, has no single answer and is refused.

## Cases

```yaml
- id: penguin
  note: Trap. Nothing says it is heavy, so under these rules it flies.
  facts: [has_feathers, lays_eggs]
  expect: [bird, flier, exportable]
```

`facts` are the features that are true; every other feature is false. `expect` lists every
conclusion that holds, not only the goals, so a case pins the whole answer. Write `expect` by hand
from the rules and let `npm run check` confirm it; a disagreement is either a slip in the case or a
rule that does not say what was meant.

## Organising

One file is one rule set, kept whole because a negated condition reads the entire set. Files sit in
a folder per subject under `rulesets/` (`animals/`, `vehicles/`, `fiction/`), and `tags` carry the
other ways to group them.
