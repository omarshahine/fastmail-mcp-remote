# Fastmail MCP Remote Server

A remote MCP (Model Context Protocol) server for Fastmail email, contacts, and calendar access, deployed on Cloudflare Workers with GitHub OAuth authentication.

## Architecture

```
┌─────────────┐      OAuth       ┌──────────────────────┐      API Token      ┌──────────────┐
│  Claude.ai  │  ─────────────►  │  Cloudflare Worker   │  ────────────────►  │   Fastmail   │
│ (MCP Client)│  (GitHub login)  │  (Remote MCP Server) │  (stored as secret) │     API      │
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

### 2. Create GitHub OAuth Apps

#### For Local Development
1. Go to https://github.com/settings/developers
2. Click **New OAuth App**
3. Fill in:
   - **Application name:** `Fastmail MCP (local)`
   - **Homepage URL:** `http://localhost:8788`
   - **Authorization callback URL:** `http://localhost:8788/callback`
4. Copy the **Client ID** and generate a **Client Secret**

#### For Production
1. Go to https://github.com/settings/developers
2. Click **New OAuth App**
3. Fill in:
   - **Application name:** `Fastmail MCP`
   - **Homepage URL:** `https://fastmail-mcp-remote.<your-subdomain>.workers.dev`
   - **Authorization callback URL:** `https://fastmail-mcp-remote.<your-subdomain>.workers.dev/callback`
4. Copy the **Client ID** and generate a **Client Secret**

### 3. Get Fastmail API Token

1. Go to https://www.fastmail.com/settings/security/tokens
2. Create a new API token with the scopes you need (Email, Contacts, Calendars)
3. Copy the token

### 4. Configure Local Secrets

Edit `.dev.vars` with your local development credentials:
```bash
GITHUB_CLIENT_ID="your-local-github-client-id"
GITHUB_CLIENT_SECRET="your-local-github-client-secret"
FASTMAIL_API_TOKEN="your-fastmail-api-token"
COOKIE_ENCRYPTION_KEY="$(openssl rand -hex 32)"
```

### 5. Test Locally

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
# Authenticate with GitHub
# Click "Connect" → "List Tools"
```

### 6. Deploy to Cloudflare

```bash
npx wrangler deploy
```

### 7. Set Production Secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
# Paste your production GitHub client ID

npx wrangler secret put GITHUB_CLIENT_SECRET
# Paste your production GitHub client secret

npx wrangler secret put FASTMAIL_API_TOKEN
# Paste your Fastmail API token

npx wrangler secret put COOKIE_ENCRYPTION_KEY
# Paste output of: openssl rand -hex 32
```

### 8. Add as Claude Custom Connector

1. Go to https://claude.ai/settings/connectors
2. Click **Add custom connector**
3. Enter your MCP server URL:
   ```
   https://fastmail-mcp-remote.<your-subdomain>.workers.dev/sse
   ```
4. Click **Add**
5. Click **Connect** and authenticate with GitHub

## User Access Control

By default, only users in the `ALLOWED_USERNAMES` set in `src/index.ts` can access the tools. Edit this to add your GitHub username:

```typescript
const ALLOWED_USERNAMES = new Set<string>([
  'omarshahine',
  // Add more GitHub usernames here
]);
```

To allow all GitHub users, leave the set empty:
```typescript
const ALLOWED_USERNAMES = new Set<string>([]);
```

## Security Notes

- Only GitHub-authenticated users can access the MCP server
- Fastmail API token stored encrypted in Cloudflare secrets
- OAuth tokens managed by Cloudflare's framework
- All traffic over HTTPS
- Add GitHub username allowlist for personal use

## Troubleshooting

**"OAuth error" when connecting**
- Verify GitHub OAuth callback URL matches your worker URL exactly
- Check that GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set correctly
- Ensure KV namespace is created and bound

**Tools not appearing**
- Check worker logs: Cloudflare Dashboard → Workers → Logs
- Verify tools are registered in the `init()` method
- Test with MCP Inspector first

**"Unauthorized" after GitHub login**
- If you added user restrictions, verify your GitHub username is in the allowed list
- Check the COOKIE_ENCRYPTION_KEY is set

**Fastmail API errors**
- Verify FASTMAIL_API_TOKEN is set as a secret
- Check token has correct permissions in Fastmail settings
- Test token manually with curl first
