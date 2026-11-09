// `claude -p` as the judge. Flags proved in Phase 0 (docs/simulation.md): no tools but the
// structured output, no MCP servers, no customizations (CLAUDE.md, skills, hooks, plugins),
// no session written to disk, a budget per call.
import type { CliOptions, Judge, JudgeAnswer } from "./judge.ts";
import { failure, inEmptyDir, lines, run, TIMEOUT_MS } from "./judge.ts";

export const BUDGET_USD = 2;

export function claudeJudge(o: CliOptions = {}): Judge {
  const timeout_ms = o.timeout_ms ?? TIMEOUT_MS;
  const flags = [
    "-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--output-format", "stream-json", "--verbose", "--max-budget-usd", String(BUDGET_USD),
    ...(o.model ? ["--model", o.model] : []),
  ];
  return {
    name: "claude",
    model: o.model ?? null,
    flags,
    ask: ({ system, prompt, schema }) => inEmptyDir("responsibilities-claude-", async (_root, work): Promise<JudgeAnswer> => {
      const args = [...flags, "--json-schema", JSON.stringify(schema), "--system-prompt", system];
      const s = await run("claude", args, { cwd: work, input: prompt, env: o.env ?? process.env, timeout_ms });
      const events = lines(s.stdout);
      const init = events.find((e) => e.type === "system" && e.subtype === "init");
      const result = events.filter((e) => e.type === "result").at(-1);
      const used = events.filter((e) => e.type === "assistant")
        .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
        .filter((block: any) => block?.type === "tool_use").map((block: any) => String(block.name));

      // The proof that no tool ran: StructuredOutput is the only tool on offer and the only one used.
      let tool_free: boolean | null = null;
      let tool_detail: string | null = null;
      if (init) {
        const tools: unknown[] = Array.isArray(init.tools) ? init.tools : [];
        const mcp: unknown[] = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
        const other = used.filter((name) => name !== "StructuredOutput");
        tool_free = tools.length === 1 && tools[0] === "StructuredOutput" && mcp.length === 0 && other.length === 0;
        tool_detail = `tools offered: [${tools.join(", ")}]; MCP servers: ${mcp.length}; tool uses: [${used.join(", ")}]`;
      }

      const output = result?.structured_output ?? null;
      const error = failure(s, "claude", timeout_ms)
        ?? (!init ? "claude printed no init event, so nothing proves that no tool ran" : null)
        ?? (!result ? "claude printed no result" : null)
        ?? (result!.is_error ? `claude reported an error: ${result!.subtype}${result!.result ? `: ${result!.result}` : ""}` : null)
        ?? (output === null ? "claude returned no structured output" : null);
      return {
        output: error ? null : output, error, tool_free, tool_detail, raw: s.stdout, stderr: s.stderr,
        exit_code: s.code, timed_out: s.timed_out, duration_ms: s.duration_ms,
        cli_version: typeof init?.claude_code_version === "string" ? init.claude_code_version : null,
        model: typeof init?.model === "string" ? init.model : o.model ?? null,
        cost_usd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
      };
    }),
  };
}
