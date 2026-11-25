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
