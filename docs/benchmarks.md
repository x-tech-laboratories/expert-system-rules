# Benchmark results

`npm run bench` gives a model a rule set as one prompt (its rules, facts and cases written out) and
scores each true/false answer against the engine. These are the results so far.

## 2026-11-24: rules given, Haiku and Sonnet

Run through `claude -p --model haiku` and `claude -p --model sonnet` on the rule sets at the time
(before `typical`, `core/upper` and the numeric quantities cases were added). The nine hand-written
rule sets ran three times each; the 50 ProofWriter depth-5 theories ran once.

| Rule sets | Questions | Haiku | Sonnet |
| --- | --- | --- | --- |
| Hand-written (9 sets, 3 runs) | 918 | 917 | 918 |
| ProofWriter depth-5 sample (50 theories) | 797 | 795 | 797 |

Haiku's three misses:

- `physics` / `bath_toys`, one run of three: said "spoon is sinking" is false; the rules conclude it.
- `relneg-cwa-d5-394`: said "rabbit likes mouse" and "rabbit sees bear" hold; under the closed world
  neither can be concluded.

**What it shows.** With the rules spelled out, current models follow them almost perfectly, even
through depth-5 chains with negation, and the trap cases built to catch real-world priors did not
catch them. These rule sets are too easy to tell models apart in this form. Harder, more telling
tests are:

1. **Reading the rules from English**, as a drafting model must: give the theory's English and score
   the rules it writes by the engine's answers ([porting.md](porting.md), task 1).
2. **Open-world answers**, where the right answer is often "unknown" (`commonsense/typical`).
3. **Scale**: hundreds of rules and facts in one prompt, where a model must find the few that matter.

## 2026-11-24: rules read from English (`bench-extract`), Haiku and Sonnet

Each model got a ProofWriter theory's English, its relation names and the names it uses, and wrote
the facts and rules; the engine then answered the theory's questions with the model's rules. Every
20th theory of the depth-5 test file (50) and every 10th of the NatLang test file (49), one run each,
four at a time.

| Theories | Answers | Haiku | Sonnet |
| --- | --- | --- | --- |
| Depth-5, generated English | 797 | 776 (49/50 theories fully right) | 797 (50/50) |
| NatLang, paraphrased English | 679 | 623 (27/49) | 645 (34/49) |

- Haiku's one depth-5 failure was unusable rather than wrong: it wrote `mouse not likes cat` inside a
  condition, which the format refuses, so all 21 answers of that theory count as wrong.
- **NatLang scores understate the models.** ProofWriter's NatLang theories were paraphrased by crowd
  workers, and some paraphrases contradict the formal theory they came from. In
  `AttNonegNatLang-CWA-290`, "when you meet someone who is nice and kind, they won't feel blue" encodes
  the rule *nice and kind → blue*, and "if someone is green and naive they may also have red, rough
  skin; it is a safe guess then that they are also round" encodes *red, rough and green → round*. A
  model that translates the English faithfully is marked wrong. The two models miss mostly the same
  theories, which points at the data. A cleaned subset is needed before NatLang can rank models.

**What it shows.** On clear English, a mid-size hosted model translates depth-5 theories with negation
into rules that reproduce every answer, and a small one nearly does; the engine's checks turn the
remaining slip into a refusal rather than a silent error. Drafting rule sets from clear text with
review looks workable. Messy, ambiguous text is where the error rate climbs, so drafts from real
sources need their test cases and a human reviewer. Local models are still to be run.

## 2026-11-26: rules read from English, a local 4B model

The same `bench-extract` test with `Spark-X2.6-4B-Q4_K_M.gguf` (4 billion parameters, 4-bit), run
through node-llama-cpp on a 4 GB GPU (all 37 layers on the GPU, about 5.9k context, temperature 0),
one prompt at a time: every 40th depth-5 theory (25) and every 20th NatLang theory (25). The two
halves took 26 minutes together.

| Theories | Answers | Score | Theories fully right | Replies unusable |
| --- | --- | --- | --- | --- |
| Depth-5, generated English | 379 | 251 (66%) | 13/25 | 7 |
| NatLang, paraphrased English | 338 | 114 (34%) | 4/25 | 16 |

**Most of the loss is format, not reasoning.** An unusable reply scores zero for the whole theory.
Counting only the replies that loaded, the model got 251 of 274 depth-5 answers (92%) and 114 of 125
NatLang answers (91%), close to Haiku. The unusable replies broke the format in ways a grammar would
prevent: YAML that does not parse, triples written in the wrong order (`rough ?x`), whole sentences
as facts ("kind and round and rough implies young"), rules written as facts, and conditions written
as field names. NatLang's looser English pushes the small model out of the format far more often.

**What it shows.** A small local model can read rules well enough, but cannot be trusted to keep to
the format unaided. Constrained output (a JSON schema or a llama.cpp grammar that only allows
declared relations, the given names and `?variables`) should recover most of the unusable replies,
and is the next thing to try before using a local model in `draft`. Hosted models remain the choice
for drafting from messy text.

## 2026-11-26: the local 4B model with a grammar (`bench-extract --grammar`)

The same 50 theories and model as above, with each reply limited by a llama.cpp grammar to the
theory's relations and names, `?x`/`?y`/`?z`, the facts-then-rules shape, and at most as many rules
as the theory has sentences.

| Theories | Without grammar | With grammar | Unusable replies |
| --- | --- | --- | --- |
| Depth-5 (379 answers) | 251 (66%) | 263 (69%) | 7 → 5 |
| NatLang (338 answers) | 114 (34%) | 261 (77%) | 16 → 2 |

**The format problem is solved; the meaning problem remains.** No reply broke the format. The 7
replies still unusable are refused for their meaning, which a grammar cannot check: 5 have a
conclusion that depends on its own negation (often through the `?x is_a thing` guard, written as a
conclusion instead of a fact), and 2 use a variable only under `not`. Among usable replies the share
of right answers fell (depth-5 263/308, 85%; NatLang 261/309, 84%), because replies that used to be
refused for their format now load and carry their slips into the score.

**What it shows.** With a grammar, a 4B model on a 4 GB GPU turns paraphrased English into loadable
rules nearly every time, and doubles its NatLang score. It is still well behind hosted models (Haiku
623/679 and Sonnet 645/679 on NatLang across 49 theories), so it can draft for review but not unattended.
The next gains would come from feeding the engine's refusal back to the model for a second round, as
`draft` already does, and from stating the guard rule more plainly in the prompt.

## 2026-11-26: the local 4B model with retries (`bench-extract --grammar --rounds 2`)

The same 50 theories, model and grammar, with the guard explained more plainly in the prompt (a
fact for every individual, a condition only, never a conclusion) and a refused reply sent back once
with the engine's reason.

| Theories | Grammar only | Grammar, plainer guard, 2 rounds | Unusable replies | Retried |
| --- | --- | --- | --- | --- |
| Depth-5 (379 answers) | 263 (69%) | 265 (70%) | 5 → 5 | 7 of 25 |
| NatLang (338 answers) | 261 (77%) | 265 (78%) | 2 → 1 | 2 of 25 |

**Small gains; the loops stay.** The unbound-variable refusals are gone: every reply still refused
after the second round has a conclusion that depends on its own negation. Told the reason, the
model rewrites the rules but keeps the loop. Among usable replies, 265 of 291 depth-5 answers (91%)
and 265 of 325 NatLang answers (82%) are right.

**What it shows.** Feedback fixes slips the model can see in one rule, such as a variable left out,
but not a loop that runs through several rules. The engine could name the rules in the loop,
not just the facts, so the model knows which rules to change. Even so, a 4B model remains a drafter
whose output a person reviews.
