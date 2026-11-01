import schema from "./schema.json" with { type: "json" };
import { canonical, wellFormed } from "./canonical.ts";

/** A contract violation: the input is refused as a whole and nothing changes. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

type Node = { [keyword: string]: any } | boolean;
const defs = schema.$defs as Record<string, Node>;

export const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** Throws an `InputError` unless `value` is canonical JSON input that conforms to `$defs/<def>`. */
export function conform(value: unknown, def: string, path: string): void {
  plain(value, path);
  const error = check(value, { $ref: `#/$defs/${def}` }, path);
  if (error !== null) throw new InputError(error);
}

function text(value: string, path: string): void {
  if (!wellFormed(value)) throw new InputError(`${path} is not well-formed Unicode`);
  if (value.normalize("NFC") !== value) throw new InputError(`${path} is not NFC`);
}

/** Only JSON values, every string and key NFC, every number finite. */
function plain(value: unknown, path: string): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") return text(value, path);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InputError(`${path} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) return Array.from(value).forEach((item, index) => plain(item, `${path}[${index}]`)); // a hole is undefined
  if (typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    for (const key of Object.keys(value)) {
      text(key, `${path} key ${JSON.stringify(key)}`);
      plain((value as Record<string, unknown>)[key], `${path}.${key}`);
    }
    return;
  }
  throw new InputError(`${path} is not JSON`);
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number";
    case "array": return Array.isArray(value);
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    default: return false;
  }
}

/** Which JSON Schema 2020-12 keywords `src/schema.json` uses, interpreted. The first error, or `null`. */
function check(value: any, node: Node, path: string): string | null {
  if (node === true) return null;
  if (node === false) return `${path} is not allowed`;
  if (node.$ref) return check(value, defs[node.$ref.slice("#/$defs/".length)]!, path);
  if (node.anyOf) {
    const errors = (node.anyOf as Node[]).map((option) => check(value, option, path));
    if (errors.includes(null)) return null;
    // The options that got furthest say the most.
    const depth = (error: string) => error.split(" ")[0]!.split(/[.[]/).length;
    const furthest = Math.max(...errors.map((error) => depth(error!)));
    return [...new Set(errors.filter((error) => depth(error!) === furthest))].join("; or ");
  }
  if ("const" in node && canonical(value) !== canonical(node.const)) return `${path} must be ${JSON.stringify(node.const)}`;
  if (node.enum && !node.enum.some((option: unknown) => canonical(option) === canonical(value))) {
    return `${path} must be one of ${node.enum.map((option: unknown) => JSON.stringify(option)).join(", ")}`;
  }
  if (node.type && !isType(value, node.type)) return `${path} must be ${node.type === "integer" ? "an integer" : `a ${node.type}`}`;

  if (typeof value === "string") {
    if (node.minLength !== undefined && value.length < node.minLength) return `${path} must not be empty`;
    if (node.pattern !== undefined && !new RegExp(node.pattern, "u").test(value)) return `${path} must match ${node.pattern}`;
    if (node.format === "date-time" && !validTime(value)) return `${path} is not a valid time`;
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) return `${path} must be at least ${node.minimum}`;
    if (node.maximum !== undefined && value > node.maximum) return `${path} must be at most ${node.maximum}`;
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) return `${path} must have at least ${node.minItems} items`;
    if (node.uniqueItems && new Set(value.map(canonical)).size !== value.length) return `${path} must not repeat an item`;
    const prefix: Node[] = node.prefixItems ?? [];
    for (let index = 0; index < value.length; index++) {
      const item = index < prefix.length ? prefix[index]! : node.items;
      const error = item === undefined ? null : check(value[index], item, `${path}[${index}]`);
      if (error !== null) return error;
    }
  }
  if (isType(value, "object")) {
    const keys = Object.keys(value);
    for (const key of node.required ?? []) if (!hasOwn(value, key)) return `${path}.${key} is required`;
    if (node.minProperties !== undefined && keys.length < node.minProperties) return `${path} must have at least ${node.minProperties} entries`;
    if (node.maxProperties !== undefined && keys.length > node.maxProperties) return `${path} must have at most ${node.maxProperties} entries`;
    for (const key of keys) {
      const property = node.properties && hasOwn(node.properties, key) ? node.properties[key] : node.additionalProperties;
      const error = property === undefined ? null : check(value[key], property, `${path}.${key}`);
      if (error !== null) return error;
    }
  }
  return null;
}

/** A real instant in the one accepted spelling; the pattern has checked the spelling. */
function validTime(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
