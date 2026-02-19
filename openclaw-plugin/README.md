# fastmail-cli

OpenClaw plugin for Fastmail email, contacts, and calendar. Provides 36 agent tools backed by a persistent in-process MCP connection for token-efficient output (5-7x savings vs raw JSON).

## Installation

```bash
openclaw install fastmail-cli
```

## Prerequisites

1. **Remote MCP Server**: Deploy the [fastmail-mcp-remote](https://github.com/omarshahine/fastmail-mcp-remote) Worker to Cloudflare.

2. **Get a Bearer Token**: Authenticate via the CLI to obtain a token:

   ```bash
   alias fastmail="npx tsx ~/path/to/fastmail-mcp-remote/cli/main.ts"
   fastmail auth --url https://your-worker.example.com --team myteam
   ```

   The token is saved to `~/.config/fastmail-cli/config.json`. Copy the `bearerToken` value for plugin configuration.

## Configuration

Both fields are **required** in your OpenClaw workspace config:

| Key | Description |
|-----|-------------|
| `workerUrl` | URL of your deployed Fastmail MCP Worker |
| `bearerToken` | Bearer token from `fastmail auth` (each user needs their own) |

Each workspace can have different credentials, enabling multi-user setups on the same machine.

## Tools

### Email Read (11 tools, always available)

- `fastmail_inbox` - Recent inbox emails
- `fastmail_get_email` - Read a single email
- `fastmail_search_emails` - Search with text and filters (sender, date, unread, etc.)
- `fastmail_get_thread` - Conversation thread
- `fastmail_list_mailboxes` - List mailboxes
- `fastmail_get_mailbox_stats` - Mailbox statistics
- `fastmail_get_account_summary` - Account overview
- `fastmail_list_identities` - Sending identities
- `fastmail_get_attachments` - Email attachments
- `fastmail_download_attachment` - Download attachment
- `fastmail_get_inbox_updates` - Incremental sync

### Email Write (3 tools, optional)

- `fastmail_send_email` - Send email
- `fastmail_create_draft` - Create draft
- `fastmail_reply_to_email` - Reply to email

### Email Organize (6 tools, optional)

- `fastmail_mark_read` - Mark as read
- `fastmail_mark_unread` - Mark as unread
- `fastmail_flag` - Flag (star)
- `fastmail_unflag` - Unflag (unstar)
- `fastmail_delete` - Delete (trash)
- `fastmail_move` - Move to mailbox

### Email Bulk (6 tools, optional)

- `fastmail_bulk_read` - Bulk mark read
- `fastmail_bulk_unread` - Bulk mark unread
- `fastmail_bulk_flag` - Bulk flag
- `fastmail_bulk_unflag` - Bulk unflag
- `fastmail_bulk_delete` - Bulk delete
- `fastmail_bulk_move` - Bulk move

### Contacts (3 tools, always available)

- `fastmail_list_contacts` - List contacts
- `fastmail_get_contact` - Contact details
- `fastmail_search_contacts` - Search contacts

### Calendar (4 tools, 3 always + 1 optional)

- `fastmail_list_calendars` - List calendars
- `fastmail_list_events` - List events
- `fastmail_get_event` - Event details
- `fastmail_create_event` - Create event (optional)

### Memos (3 tools, 1 always + 2 optional)

- `fastmail_get_memo` - Get memo on email
- `fastmail_create_memo` - Add memo (optional)
- `fastmail_delete_memo` - Delete memo (optional)

## Architecture

```
Agent -> OpenClaw Plugin -> MCP SDK (in-process) -> Remote Worker -> Fastmail JMAP API
```

The plugin maintains a persistent MCP connection per workspace:
1. Registers OpenClaw tools with JSON Schema parameters
2. On first tool call, connects to the remote Worker via MCP SDK with Bearer token auth
3. All subsequent calls reuse the same connection (no per-call overhead)
4. Responses are formatted in-process using compact text formatters

One runtime dependency: `@modelcontextprotocol/sdk`.

## Development

```bash
# Clone the repo
git clone https://github.com/omarshahine/fastmail-mcp-remote.git
cd fastmail-mcp-remote/openclaw-plugin

# Install dependencies
npm install --legacy-peer-deps

# Type check
npx tsc --noEmit

# Local test (symlink into OpenClaw extensions)
ln -s $(pwd) ~/.openclaw/extensions/fastmail-cli
```

## License

MIT
