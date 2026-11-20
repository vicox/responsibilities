# responsibilities-mcp

A remote MCP server that gives existing agents (Claude Code, Codex, ChatGPT, Claude
routines) **persistent responsibilities**: what is expected, what each run observed,
how each case was judged and what still needs attention — so an independent agent's
next run starts from the last one. The service owns the record; the agent reads its
own sources and judges. No LLM, connector, scheduler or website in the service.

Design and decisions: [docs/implementation-plan.md](docs/implementation-plan.md).

This service lives in `mcp/` of the [responsibilities](../README.md) repository. It is
a standalone package with its own `package.json` and lockfile, not part of the root
`responsibilities-core` package and not an npm workspace. Run every `npm` command below
from `mcp/`; the Vercel CLI runs from the repository root (see Deploy).

## Shape

- Next.js route handlers only (Node runtime): `/mcp`, `/oauth/{authorize,callback,token,register}`,
  `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp`;
  `/` answers one line of text.
- OAuth 2.1 authorization server for MCP clients (DCR, PKCE S256, rotating refresh
  tokens), Google as identity provider, admission by **workspace membership**.
- PostgreSQL (Neon in production, embedded PGlite in development and tests).
- Seven deterministic tools:

| Tool | Does |
| --- | --- |
| `get_server_info` | workspace, member and client of this session |
| `put_responsibility` | define or version a responsibility (expectation, subject type, assessment vocabulary) |
| `get_responsibility` | current version, last completed run, run in progress, open cases |
| `start_run` | start a run (one open per responsibility, 2 h lifetime; one idle 10 min is taken over) and get the baseline |
| `record_observations` | facts per subject (≤ 200/call, ≤ 1000/run); returns the diff to the previous observation |
| `complete_run` | decisions per subject; updates cases and attention atomically; replayable |
| `get_case` | one case's history over completed runs |

No tool takes a workspace or member argument: the session is bound from the access
token before any tool exists.

## Local development

Requires Node ≥ 22.18 (runs `.ts` directly).

```sh
cd mcp
npm ci
cp .env.example .env.local              # set OAUTH_SIGNING_SECRET and a dev Google client
npm run db:migrate -- --embedded        # creates .devdb
npm run admin -- --embedded workspace:add acme "Acme"
npm run admin -- --embedded member:add acme you@example.com
npm run dev                             # http://localhost:3000
claude mcp add --transport http responsibilities http://localhost:3000/mcp
```

`npm run dev` and the `--embedded` commands share `DEV_DATABASE_DIR` (default `.devdb`);
stop `npm run dev` before running an operator command (one process owns a PGlite
directory).

## Operator CLI

No HTTP admin surface. Same connection rule as migrations: `DATABASE_URL`, or
`--embedded` for the local development database.

```sh
npm run admin -- workspace:add <slug> "<name>"
npm run admin -- member:add <slug> <email>
npm run admin -- member:remove <email>      # sets removed_at; final
npm run admin -- member:list <slug>
```

One active membership per person. A removed member's next `/mcp` call is refused and
its refresh tokens stop working; re-adding the person creates a new membership.

## Connecting clients

Each installation registers its own client (DCR) and authorizes **once,
interactively**; unattended runs then use refresh tokens. The refresh family expires
30 days after the authorization, so headless agents are re-authorized monthly. Two
processes must not share one refresh-token cache (replay detection revokes the family).

| Runtime | How |
| --- | --- |
| Claude Code (incl. `claude -p`) | `claude mcp add --transport http responsibilities https://<origin>/mcp`, then authenticate once via `/mcp` |
| Codex CLI (incl. `codex exec`) | add the server URL to Codex's MCP config and run its MCP OAuth login once |
| claude.ai / Claude routines | add a custom connector with `https://<origin>/mcp` in claude.ai settings |
| ChatGPT | developer-mode connector, OAuth via DCR |

The exact client commands are verified at deployment (plan M3).

## Checks

```sh
npm run check      # typecheck + lint + unit/integration tests (PGlite, no network)
npm run test:pg    # real Postgres: locking/races + the OAuth store; needs TEST_DATABASE_URL
npm run build
```

`test:pg` needs a **throwaway** Postgres in `TEST_DATABASE_URL` (env or a gitignored
`.env.test.local`), e.g. a Neon branch's direct URL or local Docker:

```sh
docker run -d --rm --name rm-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=rm_test \
  -p 127.0.0.1:54329:5432 postgres:17-alpine
echo 'TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:54329/rm_test' > .env.test.local
npm run test:pg
```

## Deploy (Vercel + Neon)

Not provisioned by this repository. Rules:

1. Neon project, database `responsibilities`; Vercel project (Next.js, Node 22/24,
   **Root Directory `mcp`**), function region next to Neon; production domain **not**
   behind Vercel Deployment Protection.
2. Env vars from `.env.example` as encrypted Vercel variables scoped to **Production**
   (app uses Neon's pooled URL). Previews get none and fail closed.
3. Before every deploy: `npm run check`; before the first deploy and after any locking
   change also `npm run test:pg` against a throwaway Neon branch.
4. `DATABASE_URL=<direct url> npm run db:migrate`, **then** deploy: Git integration, or
   `vercel link` and `vercel deploy --prod` from the repository root, not from `mcp/`
   (Vercel applies the Root Directory `mcp` itself). Production never migrates from a
   request. MVP migrations only add; a destructive one follows stop → backup → migrate →
   deploy.
5. Create the workspace and members with `npm run admin` against the production URL.
6. Smoke: both discovery documents answer; unauthenticated `POST /mcp` → 401 with
   `resource_metadata`; Claude Code connects and `get_server_info` names the workspace;
   `/mcp` on the `*.vercel.app` hostname → 404.
