# Fastmail MCP Remote Server

A Cloudflare Worker that provides MCP (Model Context Protocol) access to Fastmail email, contacts, and calendar via Cloudflare Access OAuth authentication.

## Quick Reference

```bash
# Development
npm start                    # Run locally at http://localhost:8788

# Deployment
npm run deploy               # Deploy to Cloudflare Workers

# Type checking
npm run type-check           # Run TypeScript type checker
npm run cf-typegen           # Regenerate Cloudflare types
```

## Project Structure

```
src/
├── index.ts              # Main entry point, MCP tools registration, Hono routing
├── jmap-client.ts        # JMAP protocol client for Fastmail API
├── contacts-calendar.ts  # Contacts and calendar functionality
├── oauth-handler.ts      # Cloudflare Access OAuth flow handling
├── oauth-utils.ts        # OAuth utilities (token generation, validation, PKCE)
└── fastmail-auth.ts      # Fastmail authentication helpers
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

5. **Set production secrets**:
   ```bash
   npx wrangler secret put ACCESS_CLIENT_ID
   npx wrangler secret put ACCESS_CLIENT_SECRET
   npx wrangler secret put ACCESS_TEAM_NAME
   npx wrangler secret put ALLOWED_USERS
   npx wrangler secret put FASTMAIL_API_TOKEN
   npx wrangler secret put WORKER_URL
   ```

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

Set `ALLOWED_USERS` as a Cloudflare secret (comma-separated email list):
```bash
npx wrangler secret put ALLOWED_USERS
# Enter: user1@example.com,user2@example.com
```

For local development, add to `.dev.vars`:
```
ALLOWED_USERS=user1@example.com,user2@example.com
```

## Secrets Required

| Secret | Description |
|--------|-------------|
| `ACCESS_CLIENT_ID` | Cloudflare Access SaaS app client ID |
| `ACCESS_CLIENT_SECRET` | Cloudflare Access SaaS app client secret |
| `ACCESS_TEAM_NAME` | Cloudflare Zero Trust team name |
| `ALLOWED_USERS` | Comma-separated list of allowed email addresses |
| `FASTMAIL_API_TOKEN` | Fastmail API token with required scopes |
| `WORKER_URL` | Your deployed worker URL (for download links) |

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
