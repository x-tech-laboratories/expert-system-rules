# Porting other collections

Plans and findings for bringing outside bodies of rules and facts into this repository, largely with
the help of language models. ProofWriter is done; the rest is future work, in the order below.

## Principles

- **Licences first.** A collection is ported only under terms that allow adapting and sharing it.
  Every converted file keeps the original's licence in `license` and its attribution in `source`.
- **Slices, not dumps.** Rule sets work best small and scoped. Large collections are ported a topic
  at a time.
- **Machines convert, the engine checks, people review.** A converter or a model drafts; the loader
  refuses anything malformed; each rule set's cases must match the engine; drafts land as pull
  requests and are merged by a person. Nothing a model writes is merged unread.
- **Keep the original text.** A converted rule set keeps the source's own wording (ProofWriter's goes
  in `description`), so the same file can later test how well a model extracts rules from text.

## Licences

| Collection | Licence | Notes |
| --- | --- | --- |
| [ProofWriter](https://allenai.org/data/proofwriter) | CC BY | allenai.org says CC BY without a version; converted files say `CC-BY-4.0`, the version mirrors tag. Confirm with the Allen Institute if it matters. |
| [ATOMIC 2020](https://github.com/allenai/comet-atomic-2020/) | CC BY (4.0 per mirrors) | The repository says CC BY; confirm the version there before porting. The code is Apache 2.0. |
| [ConceptNet 5](https://conceptnet.io) | CC BY-SA 4.0 | The same licence as this repository's rule sets. Some edges come from sources with other terms; each edge carries its own licence field. |
| OpenCyc | unclear | Sources say Apache 2.0 for the knowledge base and CC BY 3.0 for the OWL files. [NextKB](https://www.qrg.northwestern.edu/nextkb/license.html) (CC BY 4.0) includes OpenCyc content and may be the cleaner route. |
| Wikidata | CC0 | Facts only; no licence obligations. |

## ProofWriter: done

ProofWriter (Tafjord, Dalvi and Clark, 2021) is a set of generated theories: facts and rules in
templated English with a logical form beside each, and questions with correct answers. Its
closed-world version uses negation as failure, the same `not` as this engine, so it converts without
a model.

**How.** `npm run import-proofwriter -- <meta-file.jsonl> <out-folder> [--every N]` reads one of the
`CWA/*/meta-*.jsonl` files from the
[dataset archive](https://aristo-data-public.s3.amazonaws.com/proofwriter/proofwriter-dataset-V2020.12.3.zip),
converts every theory, checks every one against the engine, and writes every Nth as a rule set.
`"someone"` and `"something"` become `?x`, `~` in a condition becomes `not`, names become
snake_case (`bald eagle` becomes `bald_eagle`), and the questions become one case: a question whose
answer says the triple holds goes under `expect`, the rest under `expect_not`. A rule whose only
mention of `?x` is under `not` gets an `?x is_a thing` condition and a `thing` fact for every entity,
since the engine fills in variables from conditions without `not`; no theory in the test files needs it.

**Results on every closed-world test file:**

| File | Theories | Fully reproduced | Refused | Answers matching ProofWriter |
| --- | --- | --- | --- | --- |
| depth-0 | 5397 | 5397 | 0 | 18949 / 18949 |
| depth-1 | 2613 | 2613 | 0 | 17624 / 17624 |
| depth-2 | 1815 | 1815 | 0 | 16535 / 16535 |
| depth-3 | 1430 | 1430 | 0 | 16642 / 16642 |
| depth-3ext | 2413 | 2413 | 0 | 21967 / 21967 |
| depth-5 | 985 | 985 | 0 | 16430 / 16430 |
| birds-electricity | 140 | 140 | 0 | 2635 / 2635 |
| NatLang | 482 | 482 | 0 | 6670 / 6670 |

Not one of the 117,452 answers differs, which is independent evidence that the engine is right.
Before per-individual layering, 71 theories (0.5%) were refused: the layering check grouped triples
by kind and could not see that a rule like "if Gary is not green then Gary is quiet" only loops back
through rules that pass along the *same* individual. The engine now falls back to layering the
filled-in rules triple by triple ("local stratification") and accepts every theory.

The repository keeps a sample of 50 depth-5 theories, every 20th of the test file, in
`rulesets/benchmarks/proofwriter-cwa-d5/`. Regenerate or widen it with the command above.

## ATOMIC 2020: next

About 1.3 million if-then statements about everyday events, in English:
`PersonX pays the bill` → `xNeed` → `to have money`. Relations cover what someone needs beforehand,
intends, wants afterwards, feels, and what others feel or do, plus physical facts about objects.

**What a model does.** Turn each event phrase into triples with variables (`PersonX` becomes `?x`,
`PersonY` becomes `?y`), choose relation names from a fixed list per slice, and write cases. This is
the `draft` command on the roadmap: source text in, a rule set out, checked by the loader and the
engine, then opened as a pull request.

**Before porting.** ATOMIC's statements hold *usually*, not always; written as hard rules they would
overstate. Add defaults and exceptions to the format first (roadmap item 5). First slice: meals and
paying, which overlaps the `routines` and `people` rule sets and can be checked against them.

## ConceptNet 5: after defaults

Millions of common-sense edges that are already triples: `IsA`, `PartOf`, `UsedFor`, `AtLocation`,
`CapableOf`, `Causes`, `HasProperty` and more, each with a weight and its own licence.

**Mapping.** Edges become facts (`IsA` to `is_a`, `AtLocation` to a location relation, and so on), kept
only where the edge's licence allows. Weights need the same defaults work as ATOMIC. A model's job here
is smaller: propose rules from patterns in the facts ("most things at a kitchen are used for cooking
or eating") and flag noisy edges for review. First slice: kitchen objects, to join the `kitchen` rule set.

## OpenCyc: once its licence is clear

Cyc's open release holds a large upper ontology and rules in CycL, a higher-order logic far more
expressive than this format. Only a subset (class hierarchies, simple Horn rules) fits. Settle the
licence first, possibly by porting from NextKB instead.

## Wikidata: facts for rule sets to reason over

Wikidata's statements are triples already. Mapping this repository's relation names to Wikidata
properties (`is_a` to P31 "instance of", `subclass_of` to P279 "subclass of", a location relation to
P276) would let a rule set run over imported reference facts.

## How well models do these jobs

The jobs differ in difficulty:

1. **Pulling facts out of text** ("the milk is in the fridge" to `milk stored_in fridge`) is the
   easiest: short input, a fixed list of relation names, and an output format a grammar can enforce.
   Small local models (3 to 4 billion parameters, the size that fits a 4 GB GPU) do this reasonably
   with constrained output, such as a JSON schema or a llama.cpp grammar. Most mistakes are a wrong
   relation or a dropped negation, which the cases catch.
2. **Turning a stated rule into a rule** ("if something is big and does not need the cow then it
   chases the cow") is harder: variables have to line up across conditions and every `not` has to
   survive. Small models slip here more often; larger hosted models are good at it. The engine
   catches unbound variables and loops, and the cases catch wrong meanings.
3. **Inventing rules from many examples** (ConceptNet patterns) is hardest and needs the most review,
   whatever the model.

**Measuring it instead of guessing.** Every converted ProofWriter file keeps its English theory in
`description` and its correct answers in its case. A model can be asked to write the rules from the
English alone, and the engine can then answer the questions with the model's rules: the share of
matching answers is a score for rule extraction, per model. That benchmark is the first thing to build
with the `draft` command, before trusting any model with ATOMIC.

The machine this started on has a 4 GB GPU shared with other work, so local runs are coordinated with
whatever else holds the GPU, and hosted models are the fallback for the harder jobs.
