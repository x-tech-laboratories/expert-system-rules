# Rule set format

A rule set is one YAML file of facts, rules and test cases about things and how they relate. Every
statement is a **triple**: `subject relation object`, such as `milk stored_in fridge` or
`penguin subclass_of bird`, the same shape as a Wikidata statement. Everything is checked when the
file loads, and a problem is refused with a message naming it.

| Field | Required | Holds |
| --- | --- | --- |
| `id` | yes | A short name, the same as the file name |
| `title` | yes | A human name |
| `description` | no | What the rule set is about and what it tests |
| `version` | yes | `major.minor.patch`, raised when the rules or answers change |
| `license` | yes | An SPDX identifier, `CC-BY-SA-4.0` for rule sets written here |
| `source` | yes | Where the rules come from, with attribution when adapted |
| `method` | no | How the rules were written, for rules that do not say: `hand_written` (the default), `llm_drafted`, `llm_drafted_human_reviewed` or `converted` |
| `tags` | no | Labels listed in `catalog.yaml`, such as `classification`, `diagnosis`, `commonsense`, `negation`, `trap-cases`, `original`, `adapted` |
| `vocabularies` | no | Shared vocabularies whose relations the file uses, such as `[core]` |
| `imports` | no | Other rule sets whose facts and rules this one builds on, such as `[core/upper]` |
| `relations` | yes, unless a vocabulary or import provides them all | Each relation the file defines and what it means |
| `facts` | no | Triples that hold in every case |
| `rules` | yes | The rules, each with `id`, `if` and `then`, and optionally `usually`, `source`, `method` and `note` |
| `world` | no | `closed` (the default) or `open`, for relations that do not say |
| `cases` | no | Test cases, each with `id`, `facts`, `expect`, `expect_not`, `expect_unknown` and an optional `note` |

A field that is not in this table is refused, so a misspelt one cannot be silently ignored.

## Names and triples

Subjects, relations and objects are `lower_snake_case` names; numbers are names too. A triple is
written as one string with single spaces, `cheese in kitchen`. Every relation must be listed under
`relations` (or come from a vocabulary or an import) with a line saying what it means, which catches
typos and tells a reader (or a model) how to read it. Quote a relation whose name YAML treats
specially, such as `"on"`. A relation may also name the Wikidata property it matches:
`owns: { meaning: The subject owns the object., wikidata: P1830 }`.

## Rules

```yaml
- { id: K4, if: [?x in ?inner, ?inner in ?outer], then: ?x in ?outer }
- { id: K7, if: [?x is_a perishable, ?x stored_in ?p, not ?p is cold], then: ?x is at_risk_of_spoiling }
```

A rule may say where it comes from and how it was written, which matters once rules are drafted by
models:

```yaml
- id: F3
  if: [?x is_a poultry, ?x cooked_to ?t, not ?t is safe_for_poultry]
  then: ?x is unsafe_to_eat
  source: "USDA FSIS: cook poultry to 165 °F (74 °C)."
  method: llm_drafted_human_reviewed
  note: The temperature check itself waits for numbers in the engine.
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
`rabbit visits mouse`. When that is not enough, because rules loop through `not` for kinds that no
single individual has at once (birds usually fly, mammals usually do not), the engine fills the
rules in for the facts at hand and layers them triple by triple instead. A conclusion that depends on
its own negation for the same individual has no single answer, and is refused, naming the triples.

## Numbers

Numbers are names too, including decimals and negatives (`23.5`, `-4`). Five built-in relations
compare them in a rule's conditions: `less_than`, `greater_than`, `at_most`, `at_least` and
`equal_to`. They need no entry under `relations`, cannot be stated as facts or concluded, and both
sides must be filled in by other conditions first. A side that is not a number makes the comparison
false; `not` in front of one negates it.

```yaml
- { id: Q8, if: [?x weight_kg ?a, ?y weight_kg ?b, ?a greater_than ?b], then: ?x heavier_than ?y }
- { id: Q9, if: [?p age_years ?n, ?n less_than 18], then: ?p is minor }
```

Units are part of the relation's name and meaning (`weight_kg`) until the engine converts them.

## Defaults and exceptions

Many everyday rules hold only usually. A rule marked `usually: true` is a default: its conclusion
holds unless the opposite is concluded. The opposite is written with `not` in a conclusion or a fact,
and means the triple is false, not merely unconcluded:

```yaml
- { id: T1, if: [?x is_a bird], then: ?x can fly, usually: true }
- { id: T2, if: [?x is_a penguin], then: not ?x can fly }
```

A penguin is a bird, so T1 would conclude that it flies, but T2 concludes it does not, so T1 gives
way. An exception can itself be a default. Opposite defaults for different kinds are fine as long
as no individual is both (birds usually fly, mammals usually do not); for one that is both (penguins
usually do not fly, but a penguin is a bird) neither can be put first and the case is refused, so
make the more specific one strict. A strict rule and a denial concluding opposite things about
the same triple is a conflict, and `npm run check` fails the case.

## Closed and open worlds

By default a rule set is a closed world: what is not concluded is false, and `not` in a condition
reads it that way. General knowledge is often an open world instead: if nothing says whether a dog
can fly, the honest answer is unknown. A relation, or a whole rule set, can say so:

```yaml
world: open                      # every relation that does not say otherwise
relations:
  can: { meaning: The subject is able to do this., world: open }
```

A triple of an open-world relation is true when concluded, false when its denial is concluded, and
unknown otherwise. A `not` condition may not read an open-world relation, since a missing triple
there proves nothing; write the exception as a `not` conclusion and mark the general rule `usually`.
Facts brought in from Wikidata, which is never complete, belong in open-world relations.

## Cases

```yaml
- id: cooler_on_counter
  note: Trap. Only the cheese's own container counts.
  facts: [cooler is cold, cooler on counter, cheese stored_in cooler]
  expect: [cheese in kitchen, cheese is cold]
  expect_not: [cheese is at_risk_of_spoiling]
```

A case adds its `facts` to the shared ones and asks questions: each triple under `expect` must hold,
each under `expect_not` must be false, and each under `expect_unknown` must be unknown. A case may describe several things at once. Write the answers
by hand from the rules and let `npm run check` confirm them; a disagreement is either a slip in the
case or a rule that does not say what was meant. The same questions are what a model is asked by
`bench`, one point each.

## Organising

Rule sets are modules. Each one is a closed world of its own (a `not` reads only that rule set and
what it imports), so a rule true in one scope cannot clash with another; the culinary and the
botanical tomato can live in different files.

- **Names.** A rule set's file is named after its `id` and sits in a subject folder under
  `rulesets/`: `rulesets/commonsense/kitchen.yaml`. Its path without `.yaml`, `commonsense/kitchen`,
  is the name other rule sets import it by.
- **Catalog.** [`catalog.yaml`](../catalog.yaml) lists the subject folders, each with an optional
  Wikidata item, and the tags. `npm run check` refuses a rule set in an unlisted folder, with an
  unlisted tag, or whose `id` is not its file name, so subjects and tags are added on purpose rather
  than sprawling. Folders hold the one main subject; tags carry every other way to slice the rule sets.
- **Vocabularies.** [`vocabularies/core.yaml`](../vocabularies/core.yaml) defines relations many
  rule sets need, such as `is_a`, `subclass_of`, `part_of` and `located_in`, each with the Wikidata
  property it matches. A rule set lists `vocabularies: [core]` to use them and may not redefine them,
  so `is_a` means the same wherever it is shared. Relations that only make sense locally (`is` for a
  property, `stored_in`) stay in the file.
- **Imports.** `imports: [core/upper]` adds another rule set's facts and rules (not its cases) to this
  one. Imported rules keep their place: `core/upper:U1` in explanations. Relations an import brings
  must not clash with this file's own. Imports may chain but not loop.
- **The backbone.** [`core/upper`](../rulesets/core/upper.yaml) is a deliberately shallow tree of the
  broadest kinds (physical objects, living things, artifacts, substances, places, agents, events,
  abstract things), with the rules that make `is_a` and `subclass_of` inherit. A rule set places its
  own kinds in it with a few `subclass_of` facts, such as `food subclass_of substance`. A kind may
  have more than one parent. Everything else is connected by relations, not by a deeper tree.
- **Versions.** Raise the patch number for fixes that change no answers, the minor number for new
  rules or cases, and the major number when existing answers change.

One file is one rule set, kept whole because a `not` reads the entire set.
