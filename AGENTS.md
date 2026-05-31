# Fastmail Remote

A remote MCP server and token-efficient CLI for Fastmail email, contacts, and calendar. The MCP server runs on Cloudflare Workers with Cloudflare Access OAuth. The CLI calls the remote server and formats responses as compact text, saving 5-7x tokens. A Code Mode endpoint (`/mcp/code`) wraps all tools into a single `code` tool using Cloudflare Dynamic Workers for additional token savings.

## Quick Reference

```bash
# Development
npm start                    # Run locally at http://localhost:8788

# Deployment
npm run deploy               # Deploy to Cloudflare Workers

# Type checking
npm run type-check           # Run TypeScript type checker
npm run cf-typegen           # Regenerate Cloudflare types

# CLI
npm run cli -- inbox         # Run CLI (or use alias: fastmail inbox)
```

## Project Structure

```
src/
├── index.ts              # Main entry point, FastmailMCP class, Hono routing, Code Mode endpoint
├── tools.ts              # All MCP tool registrations (registerAllTools), shared by DO and Code Mode
├── jmap-client.ts        # JMAP protocol client for Fastmail API (email, memos)
├── contacts-calendar.ts  # Contacts and calendar functionality
├── html-to-markdown.ts   # HTML to Markdown conversion (Turndown + linkedom)
├── permissions.ts        # Role-based access control (admin/delegate, tool categories)
├── prompt-guard.ts       # Prompt injection protection for external data
├── oauth-handler.ts      # Cloudflare Access OAuth flow handling
├── oauth-utils.ts        # OAuth utilities (token generation, validation, PKCE)
├── fastmail-auth.ts      # Fastmail authentication helpers
└── favicon.ts            # Favicon SVG for the worker

cli/
├── main.ts              # CLI entry point, commander setup, LazyClient
├── mcp-client.ts        # MCP SDK client (StreamableHTTPClientTransport + Bearer auth)
├── auth.ts              # PKCE OAuth flow + token caching (~/.config/fastmail-cli/)
├── formatters.ts        # Compact text output formatters
├── commands/
│   ├── email.ts         # Email, bulk, mailbox, account, identities commands
│   ├── contacts.ts      # Contact commands
│   ├── calendar.ts      # Calendar commands
│   └── memo.ts          # Memo commands
└── skill.md             # Claude Code skill documentation

openclaw-plugin/                     # OpenClaw plugin: "fastmail-cli" on npm
├── index.ts                         # Entry point, registers tools with CLI command
├── openclaw.plugin.json             # Plugin manifest + configSchema
├── package.json                     # npm: fastmail-cli (zero runtime deps)
├── src/
│   ├── cli-runner.ts                # execFile wrapper, buildArgs, runTool helpers
│   └── tools/
│       ├── email.ts                 # 26 email tools (read + write + organize + bulk)
│       ├── contacts.ts              # 3 contact tools
│       ├── calendar.ts              # 4 calendar tools
│       └── memo.ts                  # 3 memo tools
└── skills/fastmail/SKILL.md         # Agent guidance for tool usage
```

## Architecture

- **Entry Point**: `src/index.ts` exports Hono app with custom OAuth routing
- **OAuth**: Cloudflare Access OAuth (supports GitHub + OTP via Zero Trust)
- **API Communication**: JMAP protocol to Fastmail API (`src/jmap-client.ts`)
- **State**: Cloudflare Durable Objects with SQLite for session management
- **Storage**: KV namespace (`OAUTH_KV`) for OAuth state/code/token storage

## OAuth Flow

1. Client requests `/mcp/authorize` with `client_id`, `redirect_uri`, optional PKCE
2. Server redirects to Cloudflare Access login (GitHub or OTP)
3. User authenticates, Access redirects to `/mcp/callback` with code
4. Server exchanges code for ID token, validates user email against allowlist
5. Server issues authorization code to client
6. Client exchanges code for access token via `/mcp/token`
7. Client uses Bearer token to access `/mcp` or `/sse` endpoints

## Deployment

### First-Time Setup

1. **Login to Cloudflare**:
   ```bash
   npx wrangler login
   ```

2. **Create KV namespace** (if not exists):
   ```bash
   npx wrangler kv namespace create "OAUTH_KV"
   # Update wrangler.jsonc with the returned ID
   ```

3. **Configure Cloudflare Access Application**:
   - Go to Zero Trust Dashboard → Access → Applications
   - Create or edit your Access application
   - Add redirect URL: `https://<your-worker-domain>/mcp/callback`

4. **Get Fastmail API Token** at https://www.fastmail.com/settings/security/tokens

5. **Set production secrets and vars**:
   ```bash
   # Secrets (encrypted)
   npx wrangler secret put ACCESS_CLIENT_ID
   npx wrangler secret put ACCESS_CLIENT_SECRET
   npx wrangler secret put FASTMAIL_API_TOKEN
   npx wrangler secret put WORKER_URL
   ```

   Add plaintext vars in `wrangler.jsonc` (gitignored):
   ```jsonc
   "vars": {
     "ACCESS_TEAM_NAME": "yourteam",
     "ALLOWED_USERS": "user1@example.com,user2@example.com"
   }
   ```

   > **Warning**: Deploying without the `vars` section wipes all dashboard-set plaintext vars.

6. **Deploy**:
   ```bash
   npm run deploy
   ```

### Subsequent Deployments

```bash
npm run deploy
```

### Verify Deployment

```bash
# Check discovery endpoint (replace with your domain)
curl https://<your-worker-domain>/.well-known/oauth-authorization-server

# Check root endpoint
curl https://<your-worker-domain>/
```

## OpenClaw Plugin (npm: fastmail-cli)

The `openclaw-plugin/` directory is published to npm as `fastmail-cli`. It registers 36 OpenClaw agent tools that shell out to the `fastmail` CLI. Zero runtime dependencies — the CLI handles MCP connection, auth, and formatting.

```
Agent -> Plugin -> execFile(fastmail, args) -> CLI -> MCP SDK -> Remote Worker -> Fastmail JMAP
```

### Prerequisites

The `fastmail` CLI must be installed and authenticated: `fastmail auth status`

### Publishing to npm

```bash
cd openclaw-plugin
npm version patch   # or minor/major
npm publish --access public
```

- **No build step** — OpenClaw loads `.ts` directly via `jiti`
- **Verify before publish**: `npx tsc --noEmit` and `npm pack --dry-run`
- **Package name**: `fastmail-cli` (unscoped — `@openclaw/` is reserved for official plugins)
- **Community listing**: PR to [openclaw/openclaw](https://github.com/openclaw/openclaw) docs/plugins/community.md

### When to bump the version

- New tools added → minor bump
- Tool parameter changes, CLI arg mapping fixes → patch bump
- Breaking changes (renamed tools, removed tools) → major bump

### Plugin config

Optional `cliCommand` (default: `"fastmail"`) in OpenClaw workspace config. The CLI reads credentials from `~/.config/fastmail-cli/config.json` — no tokens needed in plugin config.

## Local Development

1. Copy `.dev.vars.example` to `.dev.vars` and fill in credentials
2. Run `npm start`
3. Test at `http://localhost:8788/sse`

Use MCP Inspector for testing:
```bash
npx @modelcontextprotocol/inspector@latest
# Enter http://localhost:8788/sse and authenticate
```

## Adding New Tools

1. Add the tool definition in `src/index.ts` within the `init()` method:
   ```typescript
   this.server.tool(
     "tool_name",
     "Tool description",
     { /* zod schema for params */ },
     async (params) => {
       // Implementation
       return { content: [{ text: "result", type: "text" }] };
     }
   );
   ```

2. If the tool needs JMAP functionality, add the method in `src/jmap-client.ts`

3. Update the `check_function_availability` tool's function list in `src/index.ts`

4. Update README.md with the new tool

## User Access Control

`ALLOWED_USERS` is a plaintext var in `wrangler.jsonc` (comma-separated email list):
```jsonc
"vars": {
  "ALLOWED_USERS": "user1@example.com,user2@example.com"
}
```

For local development, add to `.dev.vars`:
```
ALLOWED_USERS=user1@example.com,user2@example.com
```

## Configuration Reference

### Secrets (encrypted, set via `wrangler secret put`)

| Secret | Description |
|--------|-------------|
| `ACCESS_CLIENT_ID` | Cloudflare Access SaaS app client ID |
| `ACCESS_CLIENT_SECRET` | Cloudflare Access SaaS app client secret |
| `FASTMAIL_API_TOKEN` | Fastmail API token with required scopes |
| `WORKER_URL` | Your deployed worker URL (for download links) |
| `ACTION_SIGNING_KEY` | 256-bit hex key for HMAC-signed email action URLs (`openssl rand -hex 32`) |

### Plaintext Vars (in `wrangler.jsonc`, gitignored)

| Variable | Description |
|----------|-------------|
| `ACCESS_TEAM_NAME` | Cloudflare Zero Trust team name |
| `ALLOWED_USERS` | Comma-separated list of allowed email addresses |

## KV Keys

| Key Pattern | Data | TTL |
|-------------|------|-----|
| `state:{id}` | OAuth state (client_id, redirect_uri, PKCE, etc.) | 10 min |
| `code:{id}` | Auth code (user info, PKCE challenge) | 1 min |
| `token:{hash}` | Access token info (user_id, scope) | 30 days |
| `client:{id}` | Registered client info | None |

## Debugging

- **Cloudflare Dashboard**: Workers & Pages → fastmail-mcp-remote → Logs
- **Local logs**: Visible in terminal when running `npm start`
- **MCP Inspector**: Best tool for testing individual MCP tools

## Key Files

- `wrangler.jsonc` - Cloudflare Worker configuration (bindings, KV, Durable Objects)
- `.dev.vars` - Local development secrets (not committed)
- `.dev.vars.example` - Template for local secrets

## Claude Code Integration

Add to Claude Code:
```bash
claude mcp add --scope user --transport http fastmail "https://<your-worker-domain>/mcp"
```

Complete OAuth via `/mcp` in Claude Code when prompted.

## Code Mode

The `/mcp/code` endpoint wraps all Fastmail tools into a single `code` tool using Cloudflare's [Code Mode SDK](https://developers.cloudflare.com/dynamic-workers/code-mode/) and Dynamic Workers. Instead of 29+ individual tool calls, the LLM writes a TypeScript function that chains multiple API calls in one sandbox execution.

### How it works

1. LLM receives a single `code` tool with TypeScript type definitions for all Fastmail operations
2. LLM writes code like: `async () => { const emails = await codemode.search_emails({query: "invoice"}); return emails.filter(e => e.subject.includes("2024")); }`
3. Code runs in an isolated V8 sandbox (Dynamic Worker) with no network access
4. `codemode.*` calls route back to the host via Workers RPC, executing the real JMAP operations
5. Only the final result enters the context window

### Benefits

- Fewer round-trips: chain multiple operations in one call
- Smaller context: intermediate results stay in the sandbox
- Same auth/permissions: Bearer token + role-based access apply identically

### Configuration

Requires `worker_loaders` binding in `wrangler.jsonc`:
```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

### Connect via Claude Code

```bash
claude mcp add --scope user --transport http fastmail-code "https://<your-worker-domain>/mcp/code"
```

Uses the same OAuth flow as `/mcp`.

## CLI Usage

The CLI (`cli/`) is a token-efficient alternative to MCP tools. It calls the same remote Worker but formats responses as compact text.

```bash
# Setup
alias fastmail="npx tsx ~/GitHub/fastmail-mcp-remote/cli/main.ts"
fastmail auth --url https://your-worker.example.com --team yourteam
fastmail auth --headless --url https://your-worker.example.com  # SSH / no-browser
fastmail auth status                    # Shows user, server, token expiry
fastmail auth logout                    # Remove cached credentials

# Common commands
fastmail inbox                          # Recent inbox emails
fastmail email <id>                     # Read email
fastmail email search "query"           # Search
fastmail email reply <id> --body "..."  # Reply
fastmail contacts                       # List contacts
fastmail calendars                      # List calendars
```

Config stored at `~/.config/fastmail-cli/config.json` (Bearer token, 30-day TTL).
Skill file at `cli/skill.md` — teaches Claude the full command surface.

## Cloudflare Plugin & Skills

The `cloudflare@cloudflare` plugin is enabled for this project. `CLOUDFLARE_ACCOUNT_ID` is set globally in `~/.claude/settings.json` — no need to prefix wrangler commands.

### MCP Servers (`.mcp.json`)

| Server | Purpose |
|--------|---------|
| `cloudflare-api` | Full Cloudflare API via Code Mode (2 tools, ~1000 tokens) |
| `cloudflare-docs` | Semantic search of Cloudflare documentation |

### Available Skills

| Skill | Use When |
|-------|----------|
| `/cloudflare:cloudflare` | General CF platform questions (Workers, Pages, D1, R2, KV, AI) |
| `/cloudflare:workers-best-practices` | Reviewing or writing Workers code against production patterns |
| `/cloudflare:wrangler` | CLI reference for wrangler commands (deploy, KV, D1, secrets) |
| `/cloudflare:durable-objects` | Stateful coordination, RPC, SQLite storage, alarms, WebSockets |
| `/cloudflare:agents-sdk` | Building AI agents with state management and real-time features |
| `/cloudflare:build-mcp` | Scaffolding remote MCP servers with OAuth on Workers |
| `/cloudflare:build-agent` | Scaffolding AI agents on Workers |
| `/cloudflare:sandbox-sdk` | Sandboxed code execution environments |
| `/cloudflare:web-perf` | Core Web Vitals analysis and performance auditing |

### Account Configuration

- **Account ID**: Set globally via `CLOUDFLARE_ACCOUNT_ID` env var in `~/.claude/settings.json`
- **MCP auth**: Each MCP server handles its own OAuth — authenticate on first use per session
- **API MCP**: Code Mode server covers the entire Cloudflare API (DNS, Workers, KV, D1, R2, Zero Trust, etc.) via `search()` and `execute()` tools

## Code Hygiene

- **Config files** (`wrangler.jsonc`, `wrangler.toml`, `*.d.ts`, `.env*`, `*.json`): No real email addresses - use `wrangler secret put` for PII
- No hardcoded user paths (`/Users/[name]/`) - use `${HOME}` or env vars
- No API keys or secrets in code - use environment variables or Cloudflare secrets
- No phone numbers or PII in examples - use generic placeholders
- Excluded from checks: `.dev.vars.example`, `Co-Authored-By` lines, `CHANGELOG.md`

## Known Limitations

### MCP SDK Pin Must Match Agents SDK

`@modelcontextprotocol/sdk` is pinned to an exact version (no `^`) in `package.json` to match the version that the `agents` package pins internally. This forces npm to deduplicate to a single copy, preventing TypeScript type incompatibility (TS2416) where two different `McpServer` types exist.

**When upgrading `agents`:** Check what MCP SDK version it pins internally (`node -e "console.log(require('./node_modules/agents/package.json').dependencies['@modelcontextprotocol/sdk'])"`) and update our pin to match. If versions diverge, npm installs two copies and the `McpServer` type error resurfaces.

### No JMAP Sieve/Rules API (as of January 2026)

Fastmail does **not** expose `urn:ietf:params:jmap:sieve` in their production JMAP API, despite authoring [RFC 9661 - JMAP for Sieve Scripts](https://datatracker.ietf.org/doc/rfc9661/). This means email rules/filters cannot be created or managed programmatically via this MCP server.

**Available capabilities** (verified January 2026):
- `urn:ietf:params:jmap:core`
- `urn:ietf:params:jmap:mail`
- `urn:ietf:params:jmap:submission`
- `https://www.fastmail.com/dev/maskedemail`

**Workarounds for rule management:**
- Use Fastmail's web UI: Settings → Filters & Rules
- Import/export Sieve scripts as JSON via the UI
- Edit custom Sieve code directly in Settings → Filters & Rules → "Edit custom Sieve code"

This limitation may change in a future Fastmail update. Monitor their [API documentation](https://www.fastmail.com/dev/) for capability additions.

## Clawpatch (Automated Code Review)

This repo is set up for [clawpatch](https://clawpatch.ai) — an automated, semantic-feature-driven code review tool that wraps Codex CLI. Findings are graded by severity/confidence and stored in `.clawpatch/` (gitignored).

### Install once per machine

```bash
npm install -g clawpatch     # v0.1.0+
clawpatch doctor             # verifies Node 22+, Git, Codex CLI 0.130+
```

### Standard workflow

```bash
clawpatch init               # creates .clawpatch/ + config.json (first time only)
clawpatch map                # heuristic feature discovery (package bins/scripts + configs)
clawpatch review --limit 50 --jobs 5   # review all pending features
clawpatch report --output .clawpatch/reports/summary.md
clawpatch show --finding <id>          # inspect a single finding
clawpatch fix --finding <id>           # land a fix (requires clean worktree)
clawpatch revalidate --finding <id>    # re-verify a fix
clawpatch status             # quick state summary
clawpatch next               # surface the next actionable finding
```

### Repo-specific config (`.clawpatch/config.json`)

- `commands.typecheck: "npm run type-check"` — fixes get type-checked before clawpatch accepts them
- `commands.test: "npm run test"` — runs Vitest after each fix
- `git.requireCleanWorktreeForFix: true` — fixes refuse to run on dirty trees
- `review.minConfidenceToFix: "medium"` — fix command skips low-confidence findings

### ⚠ Heuristic mapping limitation (v0.1.0)

`clawpatch map` only discovers `package.json` bins/scripts and top-level config files. It does **not** walk `src/` to find:
- Hono routes (`/mcp`, `/mcp/authorize`, `/mcp/callback`, `/mcp/token`, `/mcp/code`, `/sse`, `/.well-known/*`)
- MCP tool registrations in `src/tools.ts`
- Library modules (`jmap-client`, `permissions`, `prompt-guard`, `html-to-markdown`, `action-urls`)
- CLI subcommands in `cli/commands/`
- The `openclaw-plugin/` sub-package

For full coverage, keep hand-authored feature files in `tools/clawpatch/features/` and sync them into `.clawpatch/features/` before review:

```bash
tools/clawpatch/sync-features.sh
```

The synced files match the schema in `dist/types.d.ts` (kinds: `route`, `service`, `agent-tool`, `library`, `cli-command`, `infra`). Use clawpatch's `stableId` (`sha256(parts.join("\0")).slice(0,10)` prefixed with `feat_<slug>_`). Do not commit generated `.clawpatch/` state.

### High-signal areas in this repo

Based on the first full review (52 findings across 29 features), the surfaces where clawpatch consistently flags real issues:
- `src/oauth-handler.ts` + `src/oauth-utils.ts` — JWT verification, redirect URI allowlisting, token revocation
- `src/tools.ts` + `src/jmap-client.ts` — `send_email` CC/BCC handling, keyword preservation on read/unread flips, datamarking of external content
- `src/index.ts` `/mcp/code` route — send-confirmation must apply through Code Mode bridge
- `openclaw-plugin/package.json` — `bin` field alignment with what `fastmail-cli` ships

### Reports

Markdown + JSON reports persist in `.clawpatch/reports/<runId>.{md,json}`. Filter views:
```bash
clawpatch report --severity high --output high-only.md
clawpatch report --category security --json
clawpatch report --feature feat_route_1f1d6bface
```

## Claude Code GitHub Actions

This repo uses Claude Code GitHub Actions for PR automation:

- **`claude-code-review.yml`** - Auto-reviews PRs when marked "Ready for review" (draft → ready triggers review)
- **`claude.yml`** - Responds to `@claude` mentions in PR/issue comments for manual reviews

**Workflow:** Open PRs as draft → push commits → mark "Ready for review" to trigger auto-review. Use `@claude` in comments for follow-up reviews.


<!-- BEGIN CLAUDE MEMORY IMPORT: -Users-omarshahine-GitHub-fastmail-mcp-remote -->
## Imported Claude Project Memory

Durable memory promoted from `~/.claude/projects/-Users-omarshahine-GitHub-fastmail-mcp-remote/memory` during the AGENTS.md migration. Keep this section current when project-specific operating knowledge changes.

### memory/MEMORY.md

# Fastmail MCP Remote - Memory

## Index
- [Reply drafts must use reply_to_email](feedback_replies_vs_drafts.md) — never create_draft for replies; draft is the default of reply_to_email.
- [Deploy requires unsetting CLOUDFLARE_API_TOKEN](feedback_deploy_cf_api_token.md) — env-var token lacks Workers scope; use `env -u CLOUDFLARE_API_TOKEN npx wrangler deploy`.

## Key Patterns

### Turndown + linkedom in Cloudflare Workers
- Turndown CJS requires `@mixmark-io/domino`, browser version needs `window.DOMParser` — neither works in Workers
- Solution: Parse HTML with `linkedom`'s `parseHTML()` first, pass DOM node to `turndown.turndown(document.body)`
- `HTMLElement` type doesn't exist in Worker types (only `es2021` lib) — use a local `DomNode` interface and cast to `TurndownService.FilterFunction`
- File: `src/html-to-markdown.ts`

### npm install conflicts
- Project has a peer dependency conflict: `vitest@4.x` vs `@cloudflare/vitest-pool-workers` expecting `2.0.x-3.2.x`
- Always use `--legacy-peer-deps` when installing new packages

### PII in Public Repos — CRITICAL
- **wrangler.jsonc is GITIGNORED** — it contains account_id, custom domain, KV namespace ID
- Template: `wrangler.jsonc.example` (tracked) with placeholders
- **worker-configuration.d.ts is GITIGNORED** — auto-generated, contains binding types
- **NEVER put emails, domains, account IDs, or team names in tracked files**
- Secrets via `wrangler secret put`, local dev via `.dev.vars` (gitignored)
- If PII slips in: `git filter-repo --replace-text` + `--message-callback` to scrub history
- Deploying with `"vars": {}` in wrangler.jsonc WIPES all dashboard-set plaintext vars

### Wrangler Custom Domains
- Custom domain configured in gitignored `wrangler.jsonc` via `routes` array with `custom_domain: true`
- Adding `routes` causes wrangler to default `workers_dev` and `preview_urls` to `false` — set both to `true` explicitly

### MCP Streamable HTTP uses SSE, not plain JSON
- The `@anthropic-ai/agents` SDK returns `text/event-stream` for ALL MCP responses, including `tools/list`
- SSE format: `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}\n\n`
- Any response filtering (like permissions) must parse SSE `data:` lines, not just `response.json()`
- Both `filterToolsListResponse` (JSON) and `filterSseToolsListResponse` (SSE) exist in `src/permissions.ts`

### Project Structure
- MCP tools defined in `src/index.ts` within `FastmailMCP.init()`
- JMAP client methods in `src/jmap-client.ts`
- OAuth in `src/oauth-handler.ts` + `src/oauth-utils.ts`
- Contacts/calendar in `src/contacts-calendar.ts`

### Fastmail Memos (Private Notes on Emails)
- Memos are stored as **regular emails** in a special mailbox with `role: "memos"`
- Linked to target email via `In-Reply-To` header pointing to the target's `messageId`
- No recipients (`to: null`), `from` is the user's own email
- Subject mirrors the original email's subject
- **No dedicated JMAP memo API** — uses standard `Email/set` and `Email/query`
- To find a memo: `Email/query` with `filter: { inMailbox: memosMailboxId, header: ['In-Reply-To', targetMessageId] }`
- Fastmail UI renders these as yellow highlighted memos, searchable via `has:memo`
- **CRITICAL: Must set `$memo` keyword** — without it, the memo renders as a threaded reply instead of a yellow inline annotation
- Keywords needed: `{ $seen: true, $memo: true }` — Fastmail auto-adds `$x-me-annot-2`
- Tools: `create_memo`, `get_memo`, `delete_memo` in `src/index.ts` + `src/jmap-client.ts`

### Deploying This Worker
- `wrangler.jsonc` is gitignored — can't deploy without it or Cloudflare Builds MCP
- **Cloudflare Builds MCP** (`builds.mcp.cloudflare.com`) can deploy without local config — needs OAuth via `/mcp`
- For type-checking: `worker-configuration.d.ts` is also gitignored; generate with `npx wrangler types` or create manually

### JMAP Body Content
- `getEmailById()` fetches both text and HTML body values via `fetchTextBodyValues: true, fetchHTMLBodyValues: true`
- Body content accessed via `bodyValues[partId].value` where `partId` comes from `textBody[0].partId` or `htmlBody[0].partId`
- `getThread()` now also fetches full body content (added in html-to-markdown feature)

### memory/feedback_deploy_cf_api_token.md

---
name: CLOUDFLARE_API_TOKEN env var lacks Workers deploy scope — use OAuth fallback
description: When deploying this worker, the chezmoi-managed CLOUDFLARE_API_TOKEN fails with Authentication error [code: 10000]. Unset it inline to fall back to OAuth.
type: feedback
originSessionId: f8dc4143-bdfb-4fac-8521-de6ab3336094
---
`npm run deploy` (i.e. `wrangler deploy`) fails with `Authentication error [code: 10000]` because `CLOUDFLARE_API_TOKEN` is set in the shell (from `~/.secrets-macbook-pro.env`) but that token does not have `Workers Scripts:Edit` scope for this account.

**Workaround:** Run the deploy with the env var temporarily unset so wrangler falls back to the stored `wrangler login` OAuth session:

```bash
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
```

**Why:** The env-var token takes priority over OAuth. Wrangler won't transparently fall back, so we have to strip the var for that one invocation.

**How to apply:** Use this for every `wrangler deploy` in this repo until either (a) the API token is broadened to include `Workers Scripts:Edit` / `Account:Read` / `User:Read`, or (b) the token is removed from `~/.secrets-macbook-pro.env` and we rely on OAuth only.

### memory/feedback_replies_vs_drafts.md

---
name: Reply drafts must route through reply_to_email, never create_draft
description: Guidance for the Fastmail MCP: replies (draft or send) always use reply_to_email; create_draft is for net-new only. Shapes tool descriptions and skill docs.
type: feedback
originSessionId: f8dc4143-bdfb-4fac-8521-de6ab3336094
---
For any "draft a reply" code path (skills, agents, triage UIs downstream), the correct tool is `reply_to_email` with `sendImmediately: false` (its default). Never use `create_draft` for a reply, even if you pass `inReplyTo`/`references` — it produces an orphan email with no quoted source and poor threading on the recipient side.

Rules:
- Replies → `reply_to_email`. Draft is the default; only pass `sendImmediately: true` when the user explicitly asked to send right now, and confirm before doing so.
- `replyAll: true` only when the user selected "reply all". Default is reply-to-sender-only.
- `create_draft` is reserved for net-new emails (no source message).

**Why:** Downstream triage agents (batch-processor, inbox-interviewer, reading-digest) offer a "draft a reply" branch. If they call `create_draft`, the recipient sees a fresh email rather than a threaded reply — a visible-to-others bug that damages the user's outbound communication quality.

**How to apply:** When editing this repo's tool descriptions (`src/tools.ts`) or skill files (`openclaw-plugin/skills/fastmail/SKILL.md`, `cli/skill.md`), keep the explicit "never use create_draft for replies" warnings in the `create_draft` description and in a dedicated "Replies — Critical Rules" section. The `inReplyTo`/`references` params on `create_draft` and `send_email` should be labeled as advanced-only, steering readers to `reply_to_email` for true replies.

<!-- END CLAUDE MEMORY IMPORT: -Users-omarshahine-GitHub-fastmail-mcp-remote -->
