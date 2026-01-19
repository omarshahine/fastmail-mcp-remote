# Fastmail MCP Remote Server

A Cloudflare Worker that provides MCP (Model Context Protocol) access to Fastmail email, contacts, and calendar via GitHub OAuth authentication.

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
├── index.ts              # Main entry point, MCP tools registration, FastmailMCP class
├── jmap-client.ts        # JMAP protocol client for Fastmail API
├── contacts-calendar.ts  # Contacts and calendar functionality
├── github-handler.ts     # GitHub OAuth flow handling
├── fastmail-auth.ts      # Fastmail authentication helpers
├── utils.ts              # Utility functions
└── workers-oauth-utils.ts # Cloudflare Workers OAuth utilities
```

## Architecture

- **Entry Point**: `src/index.ts` exports `FastmailMCP` Durable Object class
- **OAuth**: GitHub OAuth via `@cloudflare/workers-oauth-provider`
- **API Communication**: JMAP protocol to Fastmail API (`src/jmap-client.ts`)
- **State**: Cloudflare Durable Objects with SQLite for session management
- **Storage**: KV namespace (`OAUTH_KV`) for OAuth token storage

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

3. **Create GitHub OAuth App** at https://github.com/settings/developers:
   - Homepage URL: `https://fastmail-mcp-remote.<subdomain>.workers.dev`
   - Callback URL: `https://fastmail-mcp-remote.<subdomain>.workers.dev/callback`

4. **Get Fastmail API Token** at https://www.fastmail.com/settings/security/tokens

5. **Set production secrets**:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put FASTMAIL_API_TOKEN
   npx wrangler secret put COOKIE_ENCRYPTION_KEY  # Use: openssl rand -hex 32
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

Check worker status in Cloudflare dashboard or:
```bash
curl https://fastmail-mcp-remote.<subdomain>.workers.dev/
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

Edit `ALLOWED_USERNAMES` in `src/index.ts` to control which GitHub users can access:

```typescript
const ALLOWED_USERNAMES = new Set<string>([
  'omarshahine',
  // Add more usernames
]);
```

Empty set allows all authenticated GitHub users.

## Secrets Required

| Secret | Description |
|--------|-------------|
| `GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret |
| `FASTMAIL_API_TOKEN` | Fastmail API token with required scopes |
| `COOKIE_ENCRYPTION_KEY` | Random 32-byte hex string for cookie encryption |

## Debugging

- **Cloudflare Dashboard**: Workers & Pages → fastmail-mcp-remote → Logs
- **Local logs**: Visible in terminal when running `npm start`
- **MCP Inspector**: Best tool for testing individual MCP tools

## Key Files

- `wrangler.jsonc` - Cloudflare Worker configuration (bindings, KV, Durable Objects)
- `.dev.vars` - Local development secrets (not committed)
- `.dev.vars.example` - Template for local secrets
