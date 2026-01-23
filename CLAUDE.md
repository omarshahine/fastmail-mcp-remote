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
├── jmap-client.ts        # JMAP protocol client for Fastmail API (~1000 lines)
├── contacts-calendar.ts  # Contacts and calendar JMAP client (extends JmapClient)
├── oauth-handler.ts      # Cloudflare Access OAuth flow handling
├── oauth-utils.ts        # OAuth utilities (token generation, validation, PKCE)
└── fastmail-auth.ts      # Fastmail authentication helpers (Bearer token)
```

## Architecture

- **Entry Point**: `src/index.ts` exports Hono app with custom OAuth routing
- **OAuth**: Cloudflare Access OAuth (supports GitHub + OTP via Zero Trust)
- **API Communication**: JMAP protocol to Fastmail API (`src/jmap-client.ts`)
- **State**: Cloudflare Durable Objects with SQLite for MCP session management
- **Storage**: KV namespace (`OAUTH_KV`) for OAuth state/code/token storage

### Request Flow

```
Client → /mcp or /sse (Bearer token) → Token validation → FastmailMCP Durable Object → JMAP API
```

## MCP Tools (32 total)

### Email Tools (19)
| Tool | Description |
|------|-------------|
| `list_mailboxes` | List all mailboxes in the account |
| `list_emails` | List emails from a mailbox (optional mailboxId, limit) |
| `get_email` | Get a specific email by ID with full body content |
| `send_email` | Send an email (to, subject, textBody/htmlBody required) |
| `create_draft` | Create a draft email without sending |
| `search_emails` | Search emails by text query |
| `get_recent_emails` | Get most recent emails from inbox/mailbox |
| `mark_email_read` | Mark an email as read or unread |
| `delete_email` | Move email to trash |
| `move_email` | Move email to a different mailbox |
| `get_email_attachments` | Get list of attachments for an email |
| `download_attachment` | Get temporary download URL for attachment |
| `advanced_search` | Search with filters (from, to, date, attachments, etc.) |
| `get_thread` | Get all emails in a conversation thread |
| `get_mailbox_stats` | Get mailbox statistics (unread, total counts) |
| `get_account_summary` | Get overall account statistics |
| `bulk_mark_read` | Mark multiple emails as read/unread |
| `bulk_move` | Move multiple emails to a mailbox |
| `bulk_delete` | Delete multiple emails |

### Identity Tools (1)
| Tool | Description |
|------|-------------|
| `list_identities` | List sending identities (verified email addresses) |

### Contacts Tools (3)
| Tool | Description |
|------|-------------|
| `list_contacts` | List contacts from address book |
| `get_contact` | Get a specific contact by ID |
| `search_contacts` | Search contacts by name or email |

### Calendar Tools (4)
| Tool | Description |
|------|-------------|
| `list_calendars` | List all calendars |
| `list_calendar_events` | List events from a calendar |
| `get_calendar_event` | Get a specific event by ID |
| `create_calendar_event` | Create a new calendar event |

### Utility Tools (1)
| Tool | Description |
|------|-------------|
| `check_function_availability` | Check which tools are available based on permissions |

## OAuth Flow

1. Client requests `/mcp/authorize` with `client_id`, `redirect_uri`, optional PKCE
2. Server redirects to Cloudflare Access login (GitHub or OTP)
3. User authenticates, Access redirects to `/mcp/callback` with code
4. Server exchanges code for ID token, validates user email against allowlist
5. Server issues authorization code to client
6. Client exchanges code for access token via `/mcp/token`
7. Client uses Bearer token to access `/mcp` or `/sse` endpoints

### OAuth Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/oauth-authorization-server` | GET | OAuth discovery metadata |
| `/mcp/authorize` | GET | Start OAuth authorization flow |
| `/mcp/callback` | GET | OAuth callback from Cloudflare Access |
| `/mcp/token` | POST | Exchange auth code for access token |
| `/mcp/register` | POST | Dynamic client registration |

### MCP Endpoints

| Endpoint | Description |
|----------|-------------|
| `/mcp` | HTTP MCP endpoint (requires Bearer token) |
| `/sse` | SSE MCP endpoint (requires Bearer token) |
| `/download/:token` | Temporary attachment download (single-use token) |

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
   - Create or edit SaaS application
   - Add redirect URL: `https://fastmail-mcp-remote.<subdomain>.workers.dev/mcp/callback`

4. **Get Fastmail API Token** at https://www.fastmail.com/settings/security/tokens

5. **Set production secrets**:
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

1. Copy `.dev.vars.example` to `.dev.vars` and fill in credentials:
   ```bash
   ACCESS_CLIENT_ID="your-cloudflare-access-client-id"
   ACCESS_CLIENT_SECRET="your-cloudflare-access-client-secret"
   FASTMAIL_API_TOKEN="your-fastmail-api-token"
   ```

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

3. For contacts/calendar tools, add methods in `src/contacts-calendar.ts`

4. Update the `check_function_availability` tool's function list in `src/index.ts`

5. Update README.md with the new tool

## User Access Control

Edit `ALLOWED_USERS` in `src/oauth-utils.ts` to control which email addresses can access:

```typescript
export const ALLOWED_USERS = new Set(['omar@shahine.com']);
```

Empty set would allow all authenticated users (not recommended for production).

## Key Configuration

### Secrets Required

| Secret | Description |
|--------|-------------|
| `ACCESS_CLIENT_ID` | Cloudflare Access SaaS app client ID |
| `ACCESS_CLIENT_SECRET` | Cloudflare Access SaaS app client secret |
| `FASTMAIL_API_TOKEN` | Fastmail API token with required scopes |

### KV Keys

| Key Pattern | Data | TTL |
|-------------|------|-----|
| `state:{id}` | OAuth state (client_id, redirect_uri, PKCE, etc.) | 10 min |
| `code:{id}` | Auth code (user info, PKCE challenge) | 1 min |
| `token:{hash}` | Access token info (user_id, scope) | 30 days |
| `client:{id}` | Registered client info | None |
| `download:{token}` | Temporary attachment download metadata | 5 min |

### Token TTLs (oauth-utils.ts)

| Constant | Value | Purpose |
|----------|-------|---------|
| `STATE_TTL_SECONDS` | 600 (10 min) | OAuth state validity |
| `CODE_TTL_SECONDS` | 60 (1 min) | Authorization code validity |
| `TOKEN_TTL_SECONDS` | 2,592,000 (30 days) | Access token validity |

## Key Files

| File | Description |
|------|-------------|
| `wrangler.jsonc` | Cloudflare Worker configuration (bindings, KV, Durable Objects) |
| `.dev.vars` | Local development secrets (not committed) |
| `.dev.vars.example` | Template for local secrets |
| `package.json` | Dependencies: agents@0.3.6, hono@4.x, zod@4.x |

## JMAP Protocol Notes

- Uses `urn:ietf:params:jmap:core`, `urn:ietf:params:jmap:mail`, `urn:ietf:params:jmap:submission`
- Contacts require `urn:ietf:params:jmap:contacts` capability
- Calendar requires `urn:ietf:params:jmap:calendars` capability
- Session endpoint: `https://api.fastmail.com/jmap/session`
- Attachments use blob download URLs with template substitution

## Debugging

- **Cloudflare Dashboard**: Workers & Pages → fastmail-mcp-remote → Logs
- **Local logs**: Visible in terminal when running `npm start`
- **MCP Inspector**: Best tool for testing individual MCP tools
- **Real-time logs**: `npx wrangler tail` for production logs

### Common Issues

| Issue | Solution |
|-------|----------|
| "OAuth error" | Verify callback URL in Cloudflare Access matches worker URL |
| "Unauthorized" | Check email is in ALLOWED_USERS set |
| Contacts/Calendar errors | Check Fastmail API token has required scopes |
| Token expired | Tokens last 30 days; re-authenticate if needed |

## Claude Code Integration

Add to Claude Code:
```bash
claude mcp add --scope user --transport http fastmail "https://fastmail-mcp-remote.omar-shahine.workers.dev/mcp"
```

Complete OAuth via `/mcp` in Claude Code when prompted.

## Dependencies

```json
{
  "agents": "^0.3.6",      // Cloudflare Agents SDK for MCP
  "hono": "^4.11.3",       // Web framework
  "just-pick": "^4.2.0",   // Object utilities
  "zod": "^4.2.1"          // Schema validation
}
```

## Code Conventions

- TypeScript with strict mode
- Zod schemas for all tool parameters
- JMAP requests use tagged method calls for response correlation
- Error messages include actionable suggestions for users
- Attachment downloads use single-use tokens for security
