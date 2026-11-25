// Converts ProofWriter's closed-world theories into rule sets, with ProofWriter's own answers as the test case.

// ── Imports ──────────────────────────────────────────────────────────────────

import { triple_text, type Triple } from "../rule_set.ts";

// ── Shapes ───────────────────────────────────────────────────────────────────

interface Statement {
  text?: string;
  representation: string;
}

interface Question {
  question: string;
  answer: boolean | string;
  representation: string;
}

export interface ProofWriterRecord {
  id: string;
  theory: string;
  triples: Record<string, Statement>;
  rules: Record<string, Statement>;
  questions: Record<string, Question>;
}

interface Atom extends Triple {
  polarity: string;
}

// ── Reading ProofWriter's notation ───────────────────────────────────────────

const atom_pattern = /\("([^"]*)" "([^"]*)" "([^"]*)" "([^"]*)"\)/g;
const variable_words = new Set(["someone", "something"]);
const variable = "?x";
const thing = "thing";

const verb_meanings: Record<string, string> = {
  is: "The subject has this property.",
  is_a: "The subject is one of the things the theory talks about.",
};

function name_of(word: string): string {
  return word.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function term_of(word: string): string {
  return variable_words.has(word) ? variable : name_of(word);
}

function atoms_of(representation: string): Atom[] {
  return [...representation.matchAll(atom_pattern)].map(([, subject, relation, object, polarity]) => ({
    subject: term_of(subject),
    relation: name_of(relation),
    object: term_of(object),
    polarity,
  }));
}

function only_atom(representation: string, where: string): Atom {
  const found = atoms_of(representation);
  if (found.length !== 1) throw new Error(`${where}: expected one statement in ${representation}`);
  return found[0];
}

// Entities are what the theory talks about: every subject, and every object that is not a property.
function entities_of(triples: Triple[]): string[] {
  const found = new Set<string>();
  for (const triple of triples) {
    if (triple.subject !== variable) found.add(triple.subject);
    if (triple.relation !== "is" && triple.object !== variable) found.add(triple.object);
  }
  return [...found].sort();
}

// ── Converting ───────────────────────────────────────────────────────────────

export function convert_theory(record: ProofWriterRecord): string {
  const facts = Object.entries(record.triples).map(([key, statement]) => {
    const atom = only_atom(statement.representation, `${record.id} ${key}`);
    if (atom.polarity !== "+") throw new Error(`${record.id} ${key}: only positive facts can be converted`);
    return atom;
  });

  let needs_things = false;
  const rules = Object.entries(record.rules).map(([key, statement]) => {
    const [body, head] = statement.representation.split(/->(?=[^>]*$)/);
    const conclusion = only_atom(head ?? "", `${record.id} ${key} conclusion`);
    if (conclusion.polarity !== "+") throw new Error(`${record.id} ${key}: only positive conclusions can be converted`);
    const conditions = atoms_of(body);
    if (!conditions.length) throw new Error(`${record.id} ${key}: no conditions`);
    for (const condition of conditions) {
      if (condition.polarity !== "+" && condition.polarity !== "~") throw new Error(`${record.id} ${key}: unknown polarity ${condition.polarity}`);
    }
    const uses_variable = [conclusion, ...conditions].some(atom => atom.subject === variable || atom.object === variable);
    const binds_variable = conditions.some(atom => atom.polarity === "+" && (atom.subject === variable || atom.object === variable));
    const guard = uses_variable && !binds_variable ? [`${variable} is_a ${thing}`] : [];
    if (guard.length) needs_things = true;
    const written = [...guard, ...conditions.map(atom => (atom.polarity === "~" ? "not " : "") + triple_text(atom))];
    return { id: key.replace(/^rule/, "R"), conditions, written, conclusion };
  });

  const questions = new Map<string, { atom: Atom; holds: boolean }>();
  for (const [key, question] of Object.entries(record.questions)) {
    if (typeof question.answer !== "boolean") throw new Error(`${record.id} ${key}: answer "${question.answer}" is not true or false`);
    const atom = only_atom(question.representation, `${record.id} ${key}`);
    if (atom.polarity !== "+" && atom.polarity !== "-") throw new Error(`${record.id} ${key}: unknown polarity ${atom.polarity}`);
    const holds = question.answer === (atom.polarity === "+");
    const text = triple_text(atom);
    const earlier = questions.get(text);
    if (earlier && earlier.holds !== holds) throw new Error(`${record.id} ${key}: contradicts an earlier question about "${text}"`);
    questions.set(text, { atom, holds });
  }

  const every_triple = [...facts, ...rules.flatMap(rule => [rule.conclusion, ...rule.conditions])];
  const asked = [...questions.values()].map(question => question.atom);
  const things = needs_things ? entities_of([...every_triple, ...asked]) : [];
  const relations = [...new Set([...every_triple, ...asked].map(triple => triple.relation).concat(needs_things ? ["is_a"] : []))].sort();

  const list = (items: string[]) => `[${items.join(", ")}]`;
  return [
    `id: ${name_of(record.id).replace(/_/g, "-")}`,
    `title: ProofWriter ${record.id}`,
    `description: ${JSON.stringify(record.theory)}`,
    "license: CC-BY-4.0",
    "tags: [benchmark, proofwriter, closed-world, adapted]",
    "source: >",
    "  Converted mechanically from ProofWriter (Tafjord, Dalvi and Clark, 2021), closed-world version,",
    `  theory ${record.id}, by the Allen Institute for AI, released under CC BY at https://allenai.org/data/proofwriter.`,
    "  The description holds the theory's original English.",
    "",
    "relations:",
    ...relations.map(relation => `  ${relation}: ${verb_meanings[relation] ?? `The subject ${relation} the object.`}`),
    "",
    "rules:",
    ...rules.map(rule => `  - { id: ${rule.id}, if: ${list(rule.written)}, then: ${triple_text(rule.conclusion)} }`),
    "",
    "facts:",
    ...facts.map(fact => `  - ${triple_text(fact)}`),
    ...things.map(entity => `  - ${entity} is_a ${thing}`),
    "",
    "cases:",
    "  - id: answers",
    "    note: ProofWriter's own answers to its questions about this theory.",
    `    expect: ${list([...questions].filter(([, question]) => question.holds).map(([text]) => text))}`,
    `    expect_not: ${list([...questions].filter(([, question]) => !question.holds).map(([text]) => text))}`,
    "",
  ].join("\n");
}
