// The single delivery sink: a local inbox, runs/<id>/inbox.md, labelled by route. Each
// delivery id is written once per run (an in-memory set); there is no claim across process
// restarts: a crashed run starts again from D1 in a new run directory.
import { appendFileSync } from "node:fs";
import type { Delivery } from "../src/index.ts";
import type { Redact } from "./redact.ts";

export class Inbox {
  private readonly written = new Set<string>();
  readonly path: string;
  private readonly redact: Redact;
  constructor(path: string, redact: Redact) {
    this.path = path;
    this.redact = redact;
  }

  /** Whether this call wrote the delivery; false if its id was written before in this run. */
  deliver(d: Delivery, day: number, at: string): boolean {
    if (this.written.has(d.id)) return false;
    this.written.add(d.id);
    const keys = Object.entries(d.subject.keys).map(([k, v]) => `${k}=${v}`).join(", ");
    const block = [
      `## [${d.route}] ${d.type} · ${d.subject.type} ${keys}`,
      "",
      `- day: D${day}, ${at}`,
      `- activation: ${d.activation}`,
      `- reason: ${d.reason}`,
      `- delivery: ${d.id}`,
      `- case: ${d.case_id}`,
      "",
    ].join("\n");
    appendFileSync(this.path, `${this.redact(block)}\n`);
    return true;
  }
}
