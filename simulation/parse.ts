// The judge's structured output mapped to an Evaluation, which the core's own schema
// then validates. Anything that does not fit is an error for the one retry, never a guess.
import { InputError } from "../src/index.ts";
import type { Evaluation, Proposal, ProposedImprovement } from "../src/index.ts";
import { conform } from "../src/validate.ts";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function fields(v: unknown, path: string, names: string[]): Record<string, unknown> {
  if (!isObject(v)) throw new ParseError(`${path} must be an object`);
  for (const name of names) if (!Object.hasOwn(v, name)) throw new ParseError(`${path}.${name} is required`);
  for (const name of Object.keys(v)) if (!names.includes(name)) throw new ParseError(`${path}.${name} is not allowed`);
  return v;
}
function string(v: unknown, path: string): string {
  if (typeof v !== "string") throw new ParseError(`${path} must be a string`);
  return v.normalize("NFC");
}
function array(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ParseError(`${path} must be an array`);
  return v;
}
const strings = (v: unknown, path: string): string[] => array(v, path).map((x, i) => string(x, `${path}[${i}]`));
const nullable = (v: unknown, path: string): string | undefined => (v === null ? undefined : string(v, path));

function proposal(v: unknown, path: string): Proposal {
  const p = fields(v, path, ["subject_type", "subject_keys", "status", "cites", "title", "summary", "attentions"]);
  const keys: Record<string, string> = {};
  array(p.subject_keys, `${path}.subject_keys`).forEach((k, i) => {
    const pair = fields(k, `${path}.subject_keys[${i}]`, ["name", "value"]);
    const name = string(pair.name, `${path}.subject_keys[${i}].name`);
    if (Object.hasOwn(keys, name)) throw new ParseError(`${path}.subject_keys names ${name} twice`);
    Object.defineProperty(keys, name, { value: string(pair.value, `${path}.subject_keys[${i}].value`), enumerable: true, writable: true, configurable: true });
  });
  const status = string(p.status, `${path}.status`);
  if (status !== "open" && status !== "resolved") throw new ParseError(`${path}.status must be "open" or "resolved"`);
  const title = nullable(p.title, `${path}.title`);
  const summary = nullable(p.summary, `${path}.summary`);
  const attentions = array(p.attentions, `${path}.attentions`).map((a, i) => {
    const at = `${path}.attentions[${i}]`;
    const e = fields(a, at, ["type", "intent", "reason"]);
    const intent = string(e.intent, `${at}.intent`);
    if (intent !== "open" && intent !== "keep" && intent !== "close") throw new ParseError(`${at}.intent must be "open", "keep" or "close"`);
    return { type: string(e.type, `${at}.type`), intent, reason: string(e.reason, `${at}.reason`) } as const;
  });
  return {
    subject: { type: string(p.subject_type, `${path}.subject_type`), keys },
    status,
    cites: strings(p.cites, `${path}.cites`),
    ...(title === undefined || title === "" ? {} : { title }),
    ...(summary === undefined || summary === "" ? {} : { summary }),
    ...(attentions.length ? { attentions } : {}),
  };
}

function improvement(v: unknown, path: string): ProposedImprovement {
  const i = fields(v, path, ["key", "title", "change", "rationale", "cites"]);
  return {
    key: string(i.key, `${path}.key`), title: string(i.title, `${path}.title`), change: string(i.change, `${path}.change`),
    rationale: string(i.rationale, `${path}.rationale`), cites: strings(i.cites, `${path}.cites`),
  };
}

/** The Evaluation for this View's basis, or a `ParseError` that says what is wrong. */
export function parse(output: unknown, basis: string, evaluator: string): Evaluation {
  const o = fields(output, "output", ["proposals", "improvements"]);
  const evaluation: Evaluation = {
    basis,
    evaluator,
    proposals: array(o.proposals, "output.proposals").map((p, i) => proposal(p, `output.proposals[${i}]`)),
    improvements: array(o.improvements, "output.improvements").map((x, i) => improvement(x, `output.improvements[${i}]`)),
  };
  try {
    conform(evaluation, "evaluation", "evaluation");
  } catch (error) {
    if (error instanceof InputError) throw new ParseError(error.message);
    throw error;
  }
  return evaluation;
}

/** The JSON text of an answer, or a `ParseError`. */
export function json(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new ParseError("the answer is not JSON");
  }
}
