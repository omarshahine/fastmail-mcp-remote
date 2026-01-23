# Fastmail MCP Remote Server

A remote MCP (Model Context Protocol) server for Fastmail email, contacts, and calendar access, deployed on Cloudflare Workers with Cloudflare Access OAuth authentication.

## Architecture

```
┌─────────────┐     OAuth        ┌──────────────────────┐      API Token      ┌──────────────┐
│  Claude.ai  │  ───────────►    │  Cloudflare Worker   │  ────────────────►  │   Fastmail   │
│ (MCP Client)│  (CF Access)     │  (Remote MCP Server) │  (stored as secret) │     API      │
└─────────────┘                  └──────────────────────┘                     └──────────────┘
```

## Available Tools

### Email
- `list_mailboxes` - List all mailboxes
- `list_emails` - List emails from a mailbox
- `get_email` - Get a specific email by ID
- `send_email` - Send an email
- `search_emails` - Search emails
- `get_recent_emails` - Get most recent emails
- `mark_email_read` - Mark email as read/unread
- `delete_email` - Delete an email (move to trash)
- `move_email` - Move email to different mailbox
- `get_email_attachments` - Get attachment list
- `download_attachment` - Get attachment download URL
- `advanced_search` - Advanced email search with filters
- `get_thread` - Get all emails in a thread
- `get_mailbox_stats` - Get mailbox statistics
- `get_account_summary` - Get account summary
- `bulk_mark_read` - Mark multiple emails read/unread
- `bulk_move` - Move multiple emails
- `bulk_delete` - Delete multiple emails

### Identity
- `list_identities` - List sending identities

### Contacts
- `list_contacts` - List contacts
- `get_contact` - Get a specific contact
- `search_contacts` - Search contacts

### Calendar
- `list_calendars` - List all calendars
- `list_calendar_events` - List calendar events
- `get_calendar_event` - Get a specific event
- `create_calendar_event` - Create a new event

### Utility
- `check_function_availability` - Check available functions

## Setup Instructions

### 1. Create KV Namespace

```bash
npx wrangler login
npx wrangler kv namespace create "OAUTH_KV"
```

Copy the output ID and update `wrangler.jsonc`:
```jsonc
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "<YOUR_KV_NAMESPACE_ID>"
  }
]
```

### 2. Configure Cloudflare Access

Create a Cloudflare Access SaaS application for OAuth:

1. Go to Cloudflare Zero Trust Dashboard → Access → Applications
2. Click **Add an application** → **SaaS**
3. Fill in:
   - **Application name:** `Fastmail MCP`
   - **Application type:** Custom
4. Configure OIDC settings:
   - **Auth Type:** OIDC
   - **Redirect URI:** `https://your-worker-name.your-subdomain.workers.dev/mcp/callback`
5. Configure access policy to allow your users (e.g., email domain or specific emails)
6. Copy the **Client ID** and generate a **Client Secret**

### 3. Configure Cloudflare Access Team Name

Edit `wrangler.jsonc` to set your Cloudflare Zero Trust team name:
```jsonc
"vars": {
  "ACCESS_TEAM_NAME": "your-team-name"
}
```

This is the subdomain before `.cloudflareaccess.com` (e.g., if your login URL is `mycompany.cloudflareaccess.com`, use `mycompany`).

### 4. Update Allowed Users

Edit `src/oauth-utils.ts` to add your allowed user emails:
```typescript
export const ALLOWED_USERS = new Set(['user@example.com']);
```

### 5. Get Fastmail API Token

1. Go to https://www.fastmail.com/settings/security/tokens
2. Create a new API token with the scopes you need (Email, Contacts, Calendars)
3. Copy the token

### 6. Configure Local Secrets

Create `.dev.vars` with your local development credentials:
```bash
ACCESS_CLIENT_ID="your-cloudflare-access-client-id"
ACCESS_CLIENT_SECRET="your-cloudflare-access-client-secret"
FASTMAIL_API_TOKEN="your-fastmail-api-token"
WORKER_URL="http://localhost:8788"
```

Note: `ACCESS_TEAM_NAME` is configured in `wrangler.jsonc` vars, not in `.dev.vars`.

### 7. Test Locally

```bash
npm start
```

Server runs at `http://localhost:8788/sse`

Test with MCP Inspector:
```bash
npx @modelcontextprotocol/inspector@latest
# Open http://localhost:5173
# Enter http://localhost:8788/sse
# Click "Open OAuth Settings" → "Quick OAuth Flow"
# Authenticate via Cloudflare Access
# Click "Connect" → "List Tools"
```

### 8. Deploy to Cloudflare

```bash
npx wrangler deploy
```

### 9. Set Production Secrets

```bash
npx wrangler secret put ACCESS_CLIENT_ID
# Paste your Cloudflare Access client ID

npx wrangler secret put ACCESS_CLIENT_SECRET
# Paste your Cloudflare Access client secret

npx wrangler secret put FASTMAIL_API_TOKEN
# Paste your Fastmail API token
```

### 10. Set WORKER_URL Secret

Set the worker URL for download links:
```bash
npx wrangler secret put WORKER_URL
# Paste: https://your-worker-name.your-subdomain.workers.dev
```

### 11. Add as Claude Custom Connector

1. Go to https://claude.ai/settings/connectors
2. Click **Add custom connector**
3. Enter your MCP server URL:
   ```
   https://your-worker-name.your-subdomain.workers.dev/sse
   ```
4. Click **Add**
5. Click **Connect** and authenticate via Cloudflare Access

Or add to Claude Code:
```bash
claude mcp add --scope user --transport http fastmail "https://your-worker-name.your-subdomain.workers.dev/mcp"
```

## User Access Control

Edit `ALLOWED_USERS` in `src/oauth-utils.ts` to control which email addresses can access:

```typescript
export const ALLOWED_USERS = new Set(['user@example.com']);
```

Empty set would allow all authenticated users (not recommended).

## Security Notes

- Authentication via Cloudflare Access (supports GitHub, email OTP, and other identity providers)
- Fastmail API token stored encrypted in Cloudflare secrets
- OAuth tokens stored in Cloudflare KV with TTL expiration
- All traffic over HTTPS
- Email-based allowlist for access control

## Troubleshooting

**"OAuth error" when connecting**
- Verify Cloudflare Access redirect URI matches your worker URL exactly
- Check that ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET are set correctly
- Ensure KV namespace is created and bound
- Verify ACCESS_TEAM_NAME in `wrangler.jsonc` matches your Zero Trust team name

**Tools not appearing**
- Check worker logs: Cloudflare Dashboard → Workers → Logs
- Verify tools are registered in the `init()` method
- Test with MCP Inspector first

**"Unauthorized" after login**
- Verify your email is in the ALLOWED_USERS set in `src/oauth-utils.ts`
- Check the user email matches exactly (case-insensitive)

**Fastmail API errors**
- Verify FASTMAIL_API_TOKEN is set as a secret
- Check token has correct permissions in Fastmail settings
- Test token manually with curl first

## Acknowledgments

This project is based on [fastmail-mcp](https://github.com/MadLlama25/fastmail-mcp) by MadLlama25. The original project provided the foundation for the Fastmail JMAP integration and MCP tool implementations.
