/**
 * What the host checks before anything reaches the database or the core: limits,
 * refusals and the shape of observation rows. No rule about cases, status or
 * Attentions lives here or anywhere else under `mcp/`; responsibilities-core
 * decides those (`lib/core.ts`, plan C1).
 */

// --- limits --------------------------------------------------------------------

export const RUN_LIFETIME_MS = 2 * 60 * 60 * 1000;
/**
 * How long an open run holds its responsibility without activity: a run that has
 * not started, recorded or viewed for this long is taken over by the next
 * `start_run`, so an agent that died does not block the next one for the rest
 * of the lifetime. Until then its owner may go on writing to it.
 */
export const RUN_IDLE_MS = 10 * 60 * 1000;
/** Rows one observation kind may hold in one run. */
export const RUN_LIMIT = 1000;
export const MAX_ROWS_PER_CALL = 200;
export const MAX_KINDS_PER_RUN = 10;
export const MAX_COLUMNS = 50;
export const MAX_ROW_STRING = 500;
export const MAX_ROW_ARRAY_ITEMS = 50;

export const MAX_OPEN_CASES = 1000;
export const MAX_PROPOSALS = 1000;
export const MAX_CITES = 20;
export const MAX_PROPOSAL_ATTENTIONS = 20;
export const MAX_REASON = 300;
export const MAX_TITLE = 120;
export const MAX_SUMMARY = 1000;
export const MAX_REPORT = 65_536;
export const MAX_EXPECTATIONS = 8000;

export const RESPONSIBILITY_KEY = /^[a-z0-9][a-z0-9-]{1,62}$/;
/**
 * Observation kinds, row columns, subject keys, subject types and Attention
 * types. ASCII on purpose: an observation id is `<run_id>:<kind>`, and the
 * database orders ids `COLLATE "C"` exactly as the core compares them.
 */
export const NAME = /^[a-z][a-z0-9_]{0,59}$/;

// --- refusals ----------------------------------------------------------------

/**
 * A refusal: the request reached the tool and was refused, nothing was written.
 * Becomes an `isError` result `{error, reason, ...detail}`.
 */
export class Refusal extends Error {
  override readonly name = "Refusal";
  readonly code: string;
  readonly detail: Record<string, unknown>;

  constructor(code: string, reason: string, detail: Record<string, unknown> = {}) {
    super(reason);
    this.code = code;
    this.detail = detail;
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, reason: this.message, ...this.detail };
  }
}

// --- text ----------------------------------------------------------------------

/**
 * Where a value holds text Postgres cannot store (U+0000) or that is not
 * Unicode (an unpaired surrogate), as a path; `null` if nowhere. Keys included.
 */
export function unstorableText(value: unknown, path = "$"): string | null {
  if (typeof value === "string") return value.includes("\u0000") || !value.isWellFormed() ? path : null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = unstorableText(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      const found = unstorableText(key, `${path} key`) ?? unstorableText(inner, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

/** Refuses text that cannot be stored or hashed, before anything else looks at it. */
export function refuseUnstorableText(value: unknown): void {
  const path = unstorableText(value);
  if (path) {
    throw new Refusal("invalid_text", `${path} contains U+0000 or an unpaired surrogate.`, { path });
  }
}

// --- observation rows ----------------------------------------------------------

export type RowValue = string | number | boolean | null | string[];
export type Row = Record<string, RowValue>;

/**
 * Checks one kind's rows against the limits and returns them as given. Text
 * that is not NFC is refused, never normalised: the core compares exactly
 * (`README.md`, host obligation 6), and a silently changed value would join or
 * miss a subject the agent did not mean.
 */
export function normaliseRows(kind: string, rows: readonly Record<string, unknown>[]): Row[] {
  return rows.map((raw, index) => {
    const bad = (why: string, column?: string) =>
      new Refusal("invalid_row", `${kind} row ${index}${column ? ` column ${JSON.stringify(column)}` : ""}: ${why}`, {
        kind,
        row: index,
        ...(column ? { column } : {}),
      });
    const columns = Object.keys(raw);
    if (columns.length > MAX_COLUMNS) throw bad(`at most ${MAX_COLUMNS} columns.`);
    const row: Row = {};
    for (const column of columns) {
      if (!NAME.test(column)) throw bad(`column names match ${NAME.source}.`, column);
      const value = raw[column];
      const texts: string[] = [];
      if (value === null || typeof value === "boolean") {
        // fine as it is
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) throw bad("numbers must be finite.", column);
      } else if (typeof value === "string") {
        if (value.length > MAX_ROW_STRING) throw bad(`strings are at most ${MAX_ROW_STRING} characters.`, column);
        texts.push(value);
      } else if (Array.isArray(value)) {
        if (value.length > MAX_ROW_ARRAY_ITEMS) throw bad(`arrays hold at most ${MAX_ROW_ARRAY_ITEMS} items.`, column);
        for (const item of value) {
          if (typeof item !== "string") throw bad("arrays hold strings only.", column);
          if (item.length > MAX_ROW_STRING) throw bad(`array items are at most ${MAX_ROW_STRING} characters.`, column);
          texts.push(item);
        }
      } else {
        throw bad("values are a string, a finite number, a boolean, null, or an array of strings.", column);
      }
      for (const text of texts) {
        if (unstorableText(text)) throw bad("contains U+0000 or an unpaired surrogate.", column);
        if (text.normalize("NFC") !== text) {
          throw new Refusal("not_nfc", `${kind} row ${index} column ${JSON.stringify(column)} is not NFC; send it in NFC.`, {
            kind,
            row: index,
            column,
          });
        }
      }
      row[column] = value as RowValue; // NAME excludes __proto__
    }
    return row;
  });
}
