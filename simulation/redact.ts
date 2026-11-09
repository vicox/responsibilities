// Everything the simulation writes or prints passes through here. It reads no secrets
// itself; each CLI handles its own login. This only keeps whatever might leak through a
// child's output, an error message or the environment out of the run directory.

const NAMES = /KEY|TOKEN|SECRET|PASSWORD/i;
/** Shorter values would replace ordinary words and numbers everywhere. */
const MIN_LENGTH = 8;
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];
export const REDACTED = "[REDACTED]";

/** The values of environment variables whose names say they are secret. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => NAMES.test(name) && typeof value === "string" && value.length >= MIN_LENGTH)
    .map(([, value]) => value!);
}

/** A value as it stands in text, and as it stands inside a JSON string. */
const forms = (value: string): string[] => [...new Set([value, JSON.stringify(value).slice(1, -1)])];

export type Redact = (text: string) => string;

export function redactor(env: NodeJS.ProcessEnv): Redact {
  // The longest first, so a value inside another goes with it.
  const all = [...new Set(secretValues(env).flatMap(forms))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const value of all) out = out.split(value).join(REDACTED);
    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  };
}

/** A JSON value with every string and key redacted: redact before serializing, never after. */
export function redactDeep<T>(value: T, redact: Redact): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, redact(key), { value: redactDeep(item, redact), enumerable: true, writable: true, configurable: true });
    }
    return out as T;
  }
  return value;
}

/** Every string and key in a JSON value. */
export function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)]);
  return [];
}

/** Whether a text holds one of the values, as it is or as it stands inside a JSON string. */
export const leaks = (text: string, values: string[]): boolean => values.some((value) => forms(value).some((form) => text.includes(form)));
