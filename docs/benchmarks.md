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
