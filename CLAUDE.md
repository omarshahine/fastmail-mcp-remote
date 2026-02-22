# Fastmail Remote

A remote MCP server and token-efficient CLI for Fastmail email, contacts, and calendar. The MCP server runs on Cloudflare Workers with Cloudflare Access OAuth. The CLI calls the remote server and formats responses as compact text, saving 5-7x tokens.

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
├── index.ts              # Main entry point, MCP tools registration, Hono routing
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

## Code Hygiene

- **Config files** (`wrangler.jsonc`, `wrangler.toml`, `*.d.ts`, `.env*`, `*.json`): No real email addresses - use `wrangler secret put` for PII
- No hardcoded user paths (`/Users/[name]/`) - use `${HOME}` or env vars
- No API keys or secrets in code - use environment variables or Cloudflare secrets
- No phone numbers or PII in examples - use generic placeholders
- Excluded from checks: `.dev.vars.example`, `Co-Authored-By` lines, `CHANGELOG.md`

## Known Limitations

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
## Claude Code GitHub Actions

This repo uses Claude Code GitHub Actions for PR automation:

- **`claude-code-review.yml`** - Auto-reviews PRs when marked "Ready for review" (draft → ready triggers review)
- **`claude.yml`** - Responds to `@claude` mentions in PR/issue comments for manual reviews

**Workflow:** Open PRs as draft → push commits → mark "Ready for review" to trigger auto-review. Use `@claude` in comments for follow-up reviews.
