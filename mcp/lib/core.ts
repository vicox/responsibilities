/**
 * The one place the MCP imports responsibilities-core (plan C1, C9, variant A):
 * the core's sources from the repository root, bundled with the app. Every
 * decision about cases, status and Attentions is made by `view` and `step`;
 * nothing under `mcp/` decides one itself.
 */
export { canonical, digest, InputError, SPEC, step, view } from "../../src/index.ts";
export type * from "../../src/types.ts";
