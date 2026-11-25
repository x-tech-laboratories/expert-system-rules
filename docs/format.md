# Rule set format

A rule set is one YAML file of facts, rules and test cases about things and how they relate. Every
statement is a **triple**: `subject relation object`, such as `milk stored_in fridge` or
`penguin subclass_of bird`, the same shape as a Wikidata statement. Everything is checked when the
file loads, and a problem is refused with a message naming it.

| Field | Required | Holds |
| --- | --- | --- |
| `id` | yes | A short name, usually the file name |
| `title` | yes | A human name |
| `description` | no | What the rule set is about and what it tests |
| `license` | yes | An SPDX identifier, `CC-BY-SA-4.0` for rule sets written here |
| `source` | yes | Where the rules come from, with attribution when adapted |
| `tags` | no | Labels such as `classification`, `diagnosis`, `commonsense`, `negation`, `trap-cases`, `original`, `adapted` |
| `relations` | yes | Each relation the file uses and what it means |
| `facts` | no | Triples that hold in every case |
| `rules` | yes | The rules, each with `id`, `if` and `then` |
| `cases` | no | Test cases, each with `id`, `facts`, `expect`, `expect_not` and an optional `note` |

## Names and triples

Subjects, relations and objects are `lower_snake_case` names; numbers are names too. A triple is
written as one string with single spaces, `cheese in kitchen`. Every relation must be listed under
`relations` with a line saying what it means, which catches typos and tells a reader (or a model)
how to read it. Quote a relation whose name YAML treats specially, such as `"on"`.

## Rules

```yaml
- { id: K4, if: [?x in ?inner, ?inner in ?outer], then: ?x in ?outer }
- { id: K7, if: [?x is_a perishable, ?x stored_in ?p, not ?p is cold], then: ?x is at_risk_of_spoiling }
```

Words starting with `?` are variables. A rule applies to every way of filling its variables in that
makes all its conditions hold, and then its conclusion holds too. Two rules with the same
conclusion are alternatives: either one is enough.

`not ...` holds when that triple cannot be concluded at all (a closed world). Every variable in a
`not` condition or in the conclusion must also appear in a condition without `not`, so it is filled
in before it is read.

The engine runs rules in layers, so a `not` is only read once everything that could conclude it
has run. Triples are grouped for this by relation and, when they are fixed, by subject and object
too, so `?x is grounded` and `?x is flier` are separate, as are `cat visits mouse` and
`rabbit visits mouse`. A rule set where a conclusion depends on its own
negation has no single answer and is refused.

## Cases

```yaml
- id: cooler_on_counter
  note: Trap. Only the cheese's own container counts.
  facts: [cooler is cold, cooler on counter, cheese stored_in cooler]
  expect: [cheese in kitchen, cheese is cold]
  expect_not: [cheese is at_risk_of_spoiling]
```

A case adds its `facts` to the shared ones and asks questions: each triple under `expect` must hold
and each under `expect_not` must not. A case may describe several things at once. Write the answers
by hand from the rules and let `npm run check` confirm them; a disagreement is either a slip in the
case or a rule that does not say what was meant. The same questions are what a model is asked by
`bench`, one point each.

## Organising

One file is one rule set, kept whole because a `not` reads the entire set. Files sit in a folder per
subject under `rulesets/` (`animals/`, `commonsense/`, `vehicles/`, `fiction/`), and `tags` carry the
other ways to group them.
