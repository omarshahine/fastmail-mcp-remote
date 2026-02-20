# Fastmail Remote

A remote MCP server and token-efficient CLI for Fastmail email, contacts, and calendar access. The MCP server runs on Cloudflare Workers with Cloudflare Access OAuth authentication. The CLI calls the remote server and formats responses as compact text, saving 5-7x tokens when used with AI assistants.

## Architecture

```
┌─────────────┐     OAuth        ┌──────────────────────┐      API Token      ┌──────────────┐
│  Claude.ai  │  ───────────►    │  Cloudflare Worker   │  ────────────────►  │   Fastmail   │
│ (MCP Client)│  (CF Access)     │  (Remote MCP Server) │  (stored as secret) │     API      │
└─────────────┘                  └──────────────────────┘                     └──────────────┘

┌─────────────┐   Bearer Token   ┌──────────────────────┐      API Token      ┌──────────────┐
│ fastmail CLI│  ───────────►    │  Cloudflare Worker   │  ────────────────►  │   Fastmail   │
│   (local)   │  (PKCE OAuth)    │  (Remote MCP Server) │  (stored as secret) │     API      │
└─────────────┘                  └──────────────────────┘                     └──────────────┘
```

## Fastmail CLI

A token-efficient CLI that calls the remote MCP server and formats responses as compact text, saving 5-7x tokens compared to raw MCP tool calls.

### Quick Start

```bash
# Add alias to ~/.zshrc
alias fastmail="npx tsx ~/GitHub/fastmail-mcp-remote/cli/main.ts"

# Authenticate (one-time, tokens last 30 days)
fastmail auth --url https://your-worker.example.com --team yourteam
fastmail auth status     # Shows authenticated user, token expiry
fastmail auth logout     # Remove cached credentials

# Headless auth (SSH / no-browser environments)
fastmail auth --headless --url https://your-worker.example.com
# Prints a URL to open in any browser, then paste the token back
```

### Commands

```bash
# Inbox & reading
fastmail inbox                          # 10 most recent inbox emails
fastmail inbox --limit 20               # More emails
fastmail email <id>                     # Read email (markdown format)
fastmail email thread <threadId>        # Full conversation thread

# Searching
fastmail email search "query"           # Text search
fastmail email search "invoice" --from billing@example.com

# Composing
fastmail email send --to user@example.com --subject "Hi" --body "Hello!"
fastmail email draft --to user@example.com --subject "Draft" --body "..."
fastmail email reply <id> --body "Thanks!" --send

# Actions & bulk
fastmail email read|unread|flag|unflag|delete <id>
fastmail bulk read|delete|flag <id1> <id2> <id3>

# Mailboxes, contacts, calendar
fastmail mailboxes
fastmail contacts
fastmail calendars
fastmail events

# Memos (private notes)
fastmail memo <emailId>
fastmail memo create <emailId> --text "Note"
fastmail memo delete <emailId>
```

All commands support `--json` for raw JSON output.

### CLI Structure

```
cli/
├── main.ts              # Entry point, commander setup
├── mcp-client.ts        # MCP SDK client (StreamableHTTPClientTransport)
├── auth.ts              # PKCE OAuth flow + token caching
├── formatters.ts        # Compact text output formatters
├── commands/
│   ├── email.ts         # Email, bulk, mailbox, account commands
│   ├── contacts.ts      # Contact commands
│   ├── calendar.ts      # Calendar commands
│   └── memo.ts          # Memo commands
└── skill.md             # Claude Code skill documentation
```

## Available Tools

### Email
- `list_mailboxes` - List all mailboxes
- `list_emails` - List emails from a mailbox
- `get_email` - Get a specific email by ID (includes threading: messageId, inReplyTo, references, threadId)
- `send_email` - Send an email (supports attachments and reply threading)
- `create_draft` - Create a draft email (supports attachments and reply threading)
- `reply_to_email` - **NEW:** Reply to an email with automatic threading and quoting (like Fastmail's reply button)
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
- `flag_email` - Flag or unflag an email
- `bulk_flag` - Flag or unflag multiple emails
- `get_inbox_updates` - Get inbox changes since a previous state (incremental sync)
- `create_memo` - Add a private note (memo) to an email, rendered as a yellow inline annotation in Fastmail
- `get_memo` - Get the memo attached to an email
- `delete_memo` - Delete a memo from an email

### Email Body Formats

The `send_email`, `create_draft`, and `reply_to_email` tools support three body formats:

| Parameter | Format | Description |
|-----------|--------|-------------|
| `textBody` | Plain text | Simple text content |
| `htmlBody` | HTML | Rich HTML content |
| `markdownBody` | Markdown | GitHub-flavored Markdown (auto-converted to HTML) |

At least one body format is required. If `markdownBody` is provided, it takes precedence over `htmlBody`.

**Example with Markdown:**
```json
{
  "to": ["recipient@example.com"],
  "subject": "Meeting notes",
  "markdownBody": "# Meeting Summary\n\n- Point 1\n- Point 2\n\n**Action items:**\n1. Review proposal\n2. Send feedback"
}
```

### Sending Emails with Attachments

Both `send_email` and `create_draft` support file attachments. Attachments are passed as an array of objects with base64-encoded content:

```json
{
  "to": ["recipient@example.com"],
  "subject": "Document attached",
  "textBody": "Please see the attached file.",
  "attachments": [
    {
      "filename": "report.pdf",
      "mimeType": "application/pdf",
      "content": "<base64-encoded-file-content>"
    }
  ]
}
```

**Attachment limits:**
- Maximum file size: 25MB per attachment
- Supported: Any file type (PDF, images, documents, etc.)

**Validation:**
- Filenames are validated to prevent path traversal attacks
- MIME types must be in valid `type/subtype` format
- Base64 content is validated before upload

### Replying to Emails

The `reply_to_email` tool provides a convenient way to reply to emails with proper threading and quoting, just like Fastmail's reply button:

```json
{
  "emailId": "abc123",
  "body": "Thanks for the information!",
  "replyAll": false,
  "sendImmediately": false
}
```

**Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `emailId` | string | required | ID of the email to reply to |
| `body` | string | required | Your reply message (plain text) |
| `htmlBody` | string | optional | Your reply message (HTML) |
| `markdownBody` | string | optional | Your reply message (Markdown, auto-converted to HTML) |
| `replyAll` | boolean | `false` | Reply to all recipients (sender + CC) |
| `sendImmediately` | boolean | `false` | Send immediately vs create draft |
| `excludeQuote` | boolean | `false` | Skip quoting the original message |

**What it handles automatically:**
- **Recipients**: Uses `replyTo` or `from` address; `replyAll` includes CC recipients
- **Subject**: Adds "Re:" prefix if not already present
- **Threading**: Sets `inReplyTo` and `references` headers for proper threading
- **Quoting**: Formats quoted original in Fastmail style with attribution line

### Email Threading (Low-Level)

For manual control over threading, `send_email` and `create_draft` support `inReplyTo` and `references` parameters, and `get_email` returns threading properties:

```json
{
  "to": ["sender@example.com"],
  "subject": "Re: Original subject",
  "textBody": "My reply...",
  "inReplyTo": ["<original-message-id@example.com>"],
  "references": ["<earlier-message@example.com>", "<original-message-id@example.com>"]
}
```

**Threading properties returned by `get_email`:**
- `messageId` - The email's Message-ID header
- `inReplyTo` - Message-IDs this email replies to
- `references` - Full thread chain of Message-IDs
- `threadId` - JMAP's internal thread identifier

### Memos (Private Notes)

Add private notes to emails that render as yellow inline annotations in Fastmail's UI. Memos are personal — only visible to you.

```json
{
  "emailId": "abc123",
  "text": "Follow up on this next week"
}
```

**How it works:** Memos are stored as special emails in a hidden Memos mailbox, linked to the target email via the `In-Reply-To` header. The `$memo` JMAP keyword triggers Fastmail's yellow annotation rendering.

| Tool | Description |
|------|-------------|
| `create_memo` | Add a memo to an email |
| `get_memo` | Read the memo on an email (returns text, date, memoId) |
| `delete_memo` | Remove the memo from an email |

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
   - **Redirect URI:** `https://your-worker.example.com/mcp/callback`
5. Configure access policy to allow your users (e.g., email domain or specific emails)
6. Copy the **Client ID** and generate a **Client Secret**

### 3. Configure Environment Variables

Add `ACCESS_TEAM_NAME` and `ALLOWED_USERS` as plaintext vars in your `wrangler.jsonc` (gitignored — PII stays local):

```jsonc
"vars": {
  "ACCESS_TEAM_NAME": "yourteam",
  "ALLOWED_USERS": "user1@example.com,user2@example.com"
}
```

- **ACCESS_TEAM_NAME**: Your Cloudflare Zero Trust team name (the subdomain before `.cloudflareaccess.com`)
- **ALLOWED_USERS**: Comma-separated list of email addresses allowed to access the server

For local development, also add these to `.dev.vars` (gitignored).

> **Warning**: Deploying without the `vars` section in `wrangler.jsonc` will wipe all dashboard-set plaintext vars. Always keep `vars` in your local config.

### 4. Get Fastmail API Token

1. Go to https://www.fastmail.com/settings/security/tokens
2. Create a new API token with the scopes you need (Email, Contacts, Calendars)
3. Copy the token

### 5. Configure Local Secrets

Create `.dev.vars` with your local development credentials:
```bash
ACCESS_CLIENT_ID="your-cloudflare-access-client-id"
ACCESS_CLIENT_SECRET="your-cloudflare-access-client-secret"
FASTMAIL_API_TOKEN="your-fastmail-api-token"
WORKER_URL="http://localhost:8788"
```

Note: `ACCESS_TEAM_NAME` and `ALLOWED_USERS` are configured in `wrangler.jsonc` vars, not in `.dev.vars`.

### 6. Test Locally

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

### 7. Deploy to Cloudflare

```bash
npx wrangler deploy
```

### 8. Set Production Secrets

```bash
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put FASTMAIL_API_TOKEN
npx wrangler secret put WORKER_URL
```

### 9. Connect Clients

#### Fastmail CLI

```bash
# Add alias to ~/.zshrc
alias fastmail="npx tsx ~/GitHub/fastmail-mcp-remote/cli/main.ts"

# Authenticate (opens browser for CF Access login)
fastmail auth --url https://your-worker.example.com --team yourteam

# Or headless auth for SSH / no-browser environments
fastmail auth --headless --url https://your-worker.example.com

# Test
fastmail inbox
```

#### Claude.ai

1. Go to https://claude.ai/settings/connectors
2. Click **Add custom connector**
3. Enter your MCP server URL:
   ```
   https://your-worker.example.com/sse
   ```
4. Click **Add**
5. Click **Connect** and authenticate via Cloudflare Access

#### Claude Code

```bash
claude mcp add --scope user --transport http fastmail "https://your-worker.example.com/mcp"
```

Then run `/mcp` in Claude Code to complete the OAuth flow.

#### GitHub Copilot CLI

GitHub Copilot CLI doesn't support automatic OAuth client registration, so you need to register a client first:

1. **Register an OAuth client:**
   ```bash
   curl -X POST "https://your-worker.example.com/register" \
     -H "Content-Type: application/json" \
     -d '{"client_name": "github-copilot", "redirect_uris": ["http://localhost", "http://127.0.0.1"]}'
   ```

   Save the returned `client_id`.

2. **Add the MCP server:**
   ```bash
   copilot mcp add fastmail --url "https://your-worker.example.com/mcp"
   ```

3. **When prompted for OAuth credentials:**
   - **Client ID**: Paste the `client_id` from step 1
   - **Client Type**: Select `[1] Public (no secret)`
   - Press `Ctrl+S` to save and authenticate

## Security Notes

- Authentication via Cloudflare Access (supports GitHub, email OTP, and other identity providers)
- Fastmail API token stored encrypted in Cloudflare secrets
- OAuth tokens stored in Cloudflare KV with TTL expiration
- All traffic over HTTPS
- Email-based allowlist for access control

## Delegate Access (Role-Based Permissions)

The server supports role-based access control with two layers:

1. **Role-based** — `admin` (full access) vs `delegate` (read + inbox management + drafts)
2. **Category-based** — per-user disabled categories (e.g., hide contacts/calendar)

### Roles

| Role | Can Do | Cannot Do |
|------|--------|-----------|
| **admin** | Everything (unless categories are disabled) | — |
| **delegate** | Read email, manage inbox, create drafts, reply as draft | Send email, create calendar events |

### Tool Categories

| Category | Tools | Admin | Delegate |
|----------|-------|:-----:|:--------:|
| `EMAIL_READ` | list_mailboxes, list_emails, get_email, search_emails, get_recent_emails, get_inbox_updates, get_email_attachments, download_attachment, advanced_search, get_thread, get_mailbox_stats, get_account_summary, list_identities, get_memo | Yes | Yes |
| `CONTACTS` | list_contacts, get_contact, search_contacts | Yes | Yes |
| `CALENDAR_READ` | list_calendars, list_calendar_events, get_calendar_event | Yes | Yes |
| `CALENDAR_WRITE` | create_calendar_event | Yes | No |
| `INBOX_MANAGE` | mark_email_read, flag_email, delete_email, move_email, bulk_mark_read, bulk_move, bulk_delete, bulk_flag, create_memo, delete_memo | Yes | Yes |
| `DRAFT` | create_draft | Yes | Yes |
| `REPLY` | reply_to_email | Yes | Yes* |
| `SEND` | send_email | Yes | No |
| `META` | check_function_availability | Yes | Yes |

\* Delegates can use `reply_to_email` to create draft replies, but `sendImmediately: true` is denied.

### Configuration

Permissions are stored in Cloudflare KV under the key `config:permissions` as JSON:

```json
{
  "users": {
    "admin@example.com": {
      "role": "admin",
      "disabled_categories": []
    },
    "assistant@example.com": {
      "role": "delegate",
      "disabled_categories": ["CONTACTS", "CALENDAR_READ", "CALENDAR_WRITE"]
    }
  },
  "default_role": "admin",
  "default_disabled_categories": []
}
```

Set the config via wrangler:

```bash
# Write permissions config to KV
npx wrangler kv key put --binding=OAUTH_KV "config:permissions" '{
  "users": {
    "assistant@example.com": {
      "role": "delegate",
      "disabled_categories": ["CONTACTS", "CALENDAR_READ", "CALENDAR_WRITE"]
    }
  },
  "default_role": "admin",
  "default_disabled_categories": []
}'
```

### How It Works

- **tools/list filtering**: Delegates only see tools they're allowed to use. Disabled categories are hidden for all roles.
- **tools/call interception**: If a delegate tries to call a denied tool, they receive a JSON-RPC error with an actionable hint (e.g., "Use 'create_draft' to compose emails as drafts instead").
- **Config caching**: Permissions config is cached for 5 minutes to minimize KV reads.
- **Unknown users**: Fall back to `default_role` and `default_disabled_categories`.
- **Case-insensitive**: Email lookups are case-insensitive.

## Troubleshooting

**"OAuth error" when connecting**
- Verify Cloudflare Access redirect URI matches your worker URL exactly
- Check that ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET are set correctly
- Ensure KV namespace is created and bound
- Verify `ACCESS_TEAM_NAME` in `wrangler.jsonc` vars matches your Zero Trust team name

**Tools not appearing**
- Check worker logs: Cloudflare Dashboard → Workers → Logs
- Verify tools are registered in the `init()` method
- Test with MCP Inspector first

**"User not authorized" after login**
- Verify your email is in `ALLOWED_USERS` in `wrangler.jsonc` vars
- Check the user email matches exactly (case-insensitive)
- Ensure `wrangler.jsonc` has a `vars` section — deploying without it wipes plaintext vars

**CLI "Not authenticated"**
- Run `fastmail auth --url <url> --team <team>` to authenticate
- Run `fastmail auth --headless` for SSH / no-browser environments
- Run `fastmail auth status` to check token validity and authenticated user
- Tokens expire after 30 days — re-run `fastmail auth` to refresh
- Run `fastmail auth logout` to clear cached credentials

**Fastmail API errors**
- Verify FASTMAIL_API_TOKEN is set as a secret
- Check token has correct permissions in Fastmail settings
- Test token manually with curl first

## Acknowledgments

This project is based on [fastmail-mcp](https://github.com/MadLlama25/fastmail-mcp) by MadLlama25. The original project provided the foundation for the Fastmail JMAP integration and MCP tool implementations.
