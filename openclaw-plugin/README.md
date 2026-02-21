# fastmail-cli

OpenClaw plugin for Fastmail email, contacts, and calendar. Provides 36 agent tools that shell out to the `fastmail` CLI for token-efficient output (5-7x savings vs raw JSON). Zero runtime dependencies.

## Installation

```bash
openclaw plugins install fastmail-cli
```

## Prerequisites

1. **Remote MCP Server**: Deploy the [fastmail-mcp-remote](https://github.com/omarshahine/fastmail-mcp-remote) Worker to Cloudflare.

2. **Install and authenticate the CLI**:

   ```bash
   # Install globally (or use npx tsx path/to/cli/main.ts)
   npm install -g fastmail-cli

   # Authenticate (opens browser for Cloudflare Access login)
   fastmail auth --url https://your-worker.example.com --team myteam
   ```

   Credentials are stored at `~/.config/fastmail-cli/config.json` (Bearer token, 30-day TTL).

3. **Verify**: `fastmail auth status` should show your user and token expiry.

## Configuration

All fields are **optional**:

| Key | Default | Description |
|-----|---------|-------------|
| `cliCommand` | `"fastmail"` | Path or alias for the fastmail CLI binary |

The CLI handles all authentication. No credentials are needed in the plugin config.

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
Agent -> OpenClaw Plugin -> execFile(fastmail, args) -> CLI -> MCP SDK -> Remote Worker -> Fastmail JMAP
```

The plugin is a thin adapter layer:
1. Registers OpenClaw tools with JSON Schema parameters
2. On tool call, spawns `fastmail <command> [args]` via `execFile` (no shell, no injection risk)
3. Returns the CLI's compact text output directly as the tool response
4. CLI handles MCP connection, auth, and formatting

Zero runtime dependencies. The CLI must be installed and authenticated separately.

## Development

```bash
# Clone the repo
git clone https://github.com/omarshahine/fastmail-mcp-remote.git
cd fastmail-mcp-remote/openclaw-plugin

# Type check (no build step needed)
npx tsc --noEmit

# Local test (symlink into OpenClaw extensions)
ln -s $(pwd) ~/.openclaw/extensions/fastmail-cli
```

## License

MIT
