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
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length); // the longest first, so a value inside another goes with it
}

export type Redact = (text: string) => string;

export function redactor(env: NodeJS.ProcessEnv): Redact {
  const values = secretValues(env);
  return (text) => {
    let out = text;
    for (const value of values) out = out.split(value).join(REDACTED);
    for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  };
}
