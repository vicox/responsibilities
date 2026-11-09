// `codex exec` as the judge, with the flags proved in Phase 0 for codex-cli 0.160.0 (see
// docs/simulation.md). `--sandbox read-only` alone still lets the model run read commands and
// loads MCP servers from apps and plugins, so every feature that offers a tool is disabled. The
// proof that no tool ran: no item other than a message, reasoning or an error in the JSONL events.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliOptions, Judge, JudgeAnswer } from "./judge.ts";
import { failure, inEmptyDir, lines, run, TIMEOUT_MS } from "./judge.ts";

/** Items that are not a tool: the answer, reasoning, and a warning or error Codex reports. */
const QUIET_ITEMS = new Set(["agent_message", "reasoning", "error"]);
/** Instructions Codex loads from its home whatever the flags say. */
const GLOBAL_INSTRUCTIONS = ["AGENTS.md", "AGENTS.override.md"];
/** The features of codex-cli 0.160.0 that give the model a tool, MCP servers included. */
export const TOOL_FEATURES = [
  "shell_tool", "unified_exec", "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external", "in_app_browser",
  "computer_use", "image_generation", "multi_agent", "view_image", "hooks", "sleep_tool", "skill_search",
  "skill_mcp_dependency_install", "tool_suggest", "goals", "workspace_dependencies",
];

export function codexJudge(o: CliOptions = {}): Judge {
  const timeout_ms = o.timeout_ms ?? TIMEOUT_MS;
  const env = o.env ?? process.env;
  const flags = [
    "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "-c", "project_doc_max_bytes=0", "-c", "history.persistence=\"none\"",
    ...TOOL_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--json", "--color", "never",
    ...(o.model ? ["-m", o.model] : []),
  ];
  // The flags skip config.toml and project documents, but not the home's own instructions. Its
  // login lives there too, so the home is not swapped for an empty one; the judge refuses to run
  // while such a file exists.
  const preflight = (): string | null => {
    const home = env.CODEX_HOME || join(homedir(), ".codex");
    const found = GLOBAL_INSTRUCTIONS.map((name) => join(home, name)).filter((path) => existsSync(path));
    return found.length ? `codex would load ${found.join(" and ")} into the judge; move it away, or set CODEX_HOME to a home without it` : null;
  };
  let version: Promise<string | null> | undefined;
  const cliVersion = (cwd: string) => (version ??= run("codex", ["--version"], { cwd, input: "", env, timeout_ms: 30_000 })
    .then((s) => /codex-cli\s+(\S+)/.exec(s.stdout)?.[1] ?? null));
  return {
    name: "codex",
    model: o.model ?? null,
    flags,
    preflight,
    ask: ({ system, prompt, schema }) => inEmptyDir("responsibilities-codex-", async (root, work): Promise<JudgeAnswer> => {
      const refused = preflight();
      if (refused) {
        return {
          output: null, error: refused, tool_free: null, tool_detail: null, raw: "", stderr: "", exit_code: null, timed_out: false,
          duration_ms: 0, cli_version: null, model: o.model ?? null, cost_usd: null,
        };
      }
      const schemaFile = join(root, "schema.json");
      const lastMessage = join(root, "last-message.json");
      writeFileSync(schemaFile, JSON.stringify(schema));
      const args = [...flags, "--output-schema", schemaFile, "--output-last-message", lastMessage, "-C", work, "-"];
      const s = await run("codex", args, { cwd: work, input: `${system}\n\n---\n\n${prompt}`, env, timeout_ms });
      const events = lines(s.stdout);
      const items = events.filter((e) => typeof e.type === "string" && e.type.startsWith("item.") && e.item && typeof e.item === "object")
        .map((e) => String(e.item.type));
      const tools = [...new Set(items.filter((type) => !QUIET_ITEMS.has(type)))];
      const started = events.some((e) => e.type === "thread.started" || e.type === "turn.started");
      const tool_free = started ? tools.length === 0 : null;
      const warnings = events.filter((e) => e.type === "item.completed" && e.item?.type === "error").map((e) => String(e.item.message));
      const tool_detail = started
        ? `item types: [${[...new Set(items)].join(", ")}]${warnings.length ? `; codex reported: ${warnings.join(" | ")}` : ""}`
        : null;

      let output: unknown = null;
      let unreadable: string | null = null;
      try {
        output = JSON.parse(readFileSync(lastMessage, "utf8"));
      } catch (e) {
        unreadable = (e as NodeJS.ErrnoException).code === "ENOENT" ? "codex wrote no last message" : "codex's last message is not JSON";
      }
      // Codex reports a failed turn on stdout, not on stderr.
      const turnFailed = events.filter((e) => e.type === "turn.failed").map((e) => String(e.error?.message ?? "turn failed")).at(-1);
      const failed = failure(s, "codex", timeout_ms);
      const error = (failed && turnFailed && !s.timed_out && !s.error ? `codex exited with code ${s.code}: ${turnFailed}` : failed)
        ?? (!started ? "codex printed no thread or turn event, so nothing proves that no tool ran" : null)
        ?? unreadable;
      return {
        output: error ? null : output, error, tool_free, tool_detail, raw: s.stdout, stderr: s.stderr,
        exit_code: s.code, timed_out: s.timed_out, duration_ms: s.duration_ms,
        cli_version: await cliVersion(work), model: o.model ?? null, cost_usd: null,
      };
    }),
  };
}
