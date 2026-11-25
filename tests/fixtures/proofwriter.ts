import type { ProofWriterRecord } from "../../src/importers/proofwriter.ts";

// A small closed-world theory with a negated condition, an unbound variable under "not" and a two-word name.

export const atom = (subject: string, relation: string, object: string, polarity = "+") => `("${subject}" "${relation}" "${object}" "${polarity}")`;

export const sample_record: ProofWriterRecord = {
  id: "RelNeg-CWA-D1-7",
  theory: "The bald eagle is big. If something is big and it does not need the cow then it chases the cow.",
  triples: {
    triple1: { representation: atom("bald eagle", "is", "big") },
    triple2: { representation: atom("cow", "needs", "bald eagle") },
  },
  rules: {
    rule1: { representation: `((${atom("something", "is", "big")} ${atom("something", "needs", "cow", "~")}) -> ${atom("something", "chases", "cow")})` },
    rule2: { representation: `((${atom("someone", "is", "quiet", "~")}) -> ${atom("someone", "is", "loud")})` },
    rule3: { representation: `((${atom("cow", "needs", "something")}) -> ${atom("something", "is", "needed")})` },
  },
  questions: {
    Q1: { question: "The bald eagle chases the cow.", answer: true, representation: atom("bald eagle", "chases", "cow") },
    Q2: { question: "The bald eagle does not chase the cow.", answer: false, representation: atom("bald eagle", "chases", "cow", "-") },
    Q3: { question: "The cow does not chase the cow.", answer: true, representation: atom("cow", "chases", "cow", "-") },
    Q4: { question: "The cow is loud.", answer: true, representation: atom("cow", "is", "loud") },
    Q5: { question: "The cow visits the bald eagle.", answer: false, representation: atom("cow", "visits", "bald eagle") },
  },
};
