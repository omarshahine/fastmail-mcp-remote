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

3. **Configure Cloudflare Access Application** (reuse "Travel Hub MCP" app):
   - Go to Zero Trust Dashboard → Access → Applications
   - Edit "Travel Hub MCP" application
   - Add redirect URL: `https://fastmail-mcp-remote.omar-shahine.workers.dev/mcp/callback`
   - Keep existing travel-hub callback URL

4. **Get Fastmail API Token** at https://www.fastmail.com/settings/security/tokens

5. **Set production secrets** (same ACCESS credentials as travel-hub):
   ```bash
   npx wrangler secret put ACCESS_CLIENT_ID
   npx wrangler secret put ACCESS_CLIENT_SECRET
   npx wrangler secret put FASTMAIL_API_TOKEN
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
# Check discovery endpoint
curl https://fastmail-mcp-remote.omar-shahine.workers.dev/.well-known/oauth-authorization-server

# Check root endpoint
curl https://fastmail-mcp-remote.omar-shahine.workers.dev/
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

Edit `ALLOWED_USERS` in `src/oauth-utils.ts` to control which email addresses can access:

```typescript
export const ALLOWED_USERS = new Set(['omar@shahine.com']);
```

Empty set would allow all authenticated users (not recommended).

## Secrets Required

| Secret | Description |
|--------|-------------|
| `ACCESS_CLIENT_ID` | Cloudflare Access SaaS app client ID (same as travel-hub MCP) |
| `ACCESS_CLIENT_SECRET` | Cloudflare Access SaaS app client secret (same as travel-hub MCP) |
| `FASTMAIL_API_TOKEN` | Fastmail API token with required scopes |

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
claude mcp add --scope user --transport http fastmail "https://fastmail-mcp-remote.omar-shahine.workers.dev/mcp"
```

Complete OAuth via `/mcp` in Claude Code when prompted.
