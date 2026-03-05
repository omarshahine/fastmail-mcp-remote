---
description: Query and manage Fastmail email, contacts, and calendar via CLI. Prefer this over MCP tools for token efficiency.
allowed-tools: Bash(fastmail:*)
---

# Fastmail CLI

Token-efficient CLI for Fastmail that calls the remote MCP server. Use this instead of the Fastmail MCP tools — the compact output format saves 5-7x tokens.

## Setup

```bash
# Add to ~/.zshrc
alias fastmail="npx tsx ~/GitHub/fastmail-mcp-remote/cli/main.ts"

# Authenticate (one-time, tokens last 30 days)
fastmail auth --url https://your-worker.example.com --team myteam
fastmail auth status    # Check token validity and authenticated user
fastmail auth logout    # Remove cached credentials

# Headless auth (SSH / no-browser environments)
fastmail auth --headless --url https://your-worker.example.com
```

## Quick Reference

### Inbox & Reading

```bash
fastmail inbox                          # 10 most recent inbox emails
fastmail inbox --limit 20               # More emails
fastmail inbox --mailbox Sent           # Different mailbox

fastmail email <id>                     # Read email (markdown format)
fastmail email <id> --raw               # Read email (raw JSON)
fastmail email thread <threadId>        # Full conversation thread
```

### Searching

```bash
fastmail email search "project update"              # Text search
fastmail email search "invoice" --from billing@co    # With sender filter
fastmail email search "" --after 2026-02-01 --unread # Advanced filters
fastmail email search "" --attachments --limit 5     # Emails with attachments
```

### Composing

```bash
fastmail email send --to user@example.com --subject "Hi" --body "Hello!"
fastmail email draft --to user@example.com --subject "Draft" --body "..."
fastmail email reply <id> --body "Thanks!" --send    # Send reply immediately
fastmail email reply <id> --body "Thanks!"           # Save as draft
fastmail email reply <id> --body "Noted" --all       # Reply all
```

### Email Actions

```bash
fastmail email read <id>                # Mark as read
fastmail email unread <id>              # Mark as unread
fastmail email flag <id>                # Flag/star
fastmail email unflag <id>              # Unflag
fastmail email delete <id>              # Move to trash
fastmail email move <id> <mailboxId>    # Move to mailbox
```

### Bulk Operations

```bash
fastmail bulk read <id1> <id2> <id3>           # Mark multiple as read
fastmail bulk delete <id1> <id2>               # Delete multiple
fastmail bulk move <mailboxId> <id1> <id2>     # Move multiple
fastmail bulk flag <id1> <id2>                 # Flag multiple
```

### Mailboxes & Account

```bash
fastmail mailboxes                      # List all mailboxes (with IDs)
fastmail mailbox-stats                  # Stats for all mailboxes
fastmail mailbox-stats <mailboxId>      # Stats for specific mailbox
fastmail account                        # Account summary
fastmail identities                     # Sending identities
```

### Contacts

```bash
fastmail contacts                       # List contacts
fastmail contacts --limit 100           # More contacts
fastmail contacts search "John"         # Search by name/email
fastmail contact <id>                   # Full contact details
```

### Calendar

```bash
fastmail calendars                      # List calendars
fastmail events                         # List events
fastmail events --calendar <id>         # Events from specific calendar
fastmail event <id>                     # Event details
fastmail event create --calendar <id> --title "Meeting" --start "2026-02-20T14:00:00" --end "2026-02-20T15:00:00"
```

### Memos (Private Notes)

```bash
fastmail memo <emailId>                         # Get memo on an email
fastmail memo create <emailId> --text "Note"    # Add memo
fastmail memo delete <emailId>                  # Delete memo
```

### Incremental Sync

```bash
fastmail updates                        # Get current state + all inbox emails
fastmail updates --since <stateToken>   # Only changes since last check
```

### Schema Introspection

```bash
fastmail describe                      # List all available MCP tools
fastmail describe get_email            # Show schema for a specific tool
fastmail describe get_email --json     # Machine-readable JSON schema
```

### Dry Run (preview mutations)

All mutation commands support `--dry-run` to preview without executing:

```bash
fastmail email send --to user@example.com --subject "Hi" --body "Hello" --dry-run
fastmail email delete <id> --dry-run
fastmail bulk delete <id1> <id2> --dry-run
fastmail event create --calendar <id> --title "Meeting" --start "..." --end "..." --dry-run
fastmail memo create <emailId> --text "Note" --dry-run
```

### Field Masks (JSON output filtering)

Use `--fields` with `--json` to limit response fields and save tokens:

```bash
fastmail inbox --json --fields "id,subject,from"
fastmail contacts --json --fields "id,name,emails"
fastmail events --json --fields "id,title,start,end"
```

## Output Format

The CLI outputs compact text optimized for LLM consumption. Email IDs appear first on each line for easy extraction.

### Email List
```
# inbox (10)

M1234abc  2026-02-19 10:30  *John Smith <john@ex.com>
  Re: Project Update — Preview of the email content...

M5678def  2026-02-19 09:15   Jane Doe <jane@ex.com> [att]
  Contract Review — Please review the attached...
```

Indicators: `*` = unread, `!` = flagged, `[att]` = has attachments

### Single Email
```
From: John Smith <john@example.com>
To: me@example.com
Date: 2026-02-19 10:30
Subject: Re: Project Update
ID: M1234abc | Thread: T5678

[markdown body content]
```

### All commands support `--json` for raw JSON output when structured parsing is needed.

## Common Workflows

### Check inbox and read an email
```bash
fastmail inbox                # See list, note IDs
fastmail email M1234abc       # Read the email
```

### Search, read, and reply
```bash
fastmail email search "invoice"       # Find emails
fastmail email M5678def               # Read one
fastmail email reply M5678def --body "Received, thanks." --send
```

### Triage inbox
```bash
fastmail inbox --limit 20             # See what's new
fastmail bulk read M1 M2 M3           # Mark read
fastmail email delete M4              # Trash one
fastmail email move M5 <archiveId>    # Archive one
```

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | — |
| 1 | Generic error | Check stderr |
| 2 | Authentication failure | Run `fastmail auth --url <url>` |
| 3 | Invalid input | Fix arguments (bad ID, email, date format) |
| 4 | Server/network error | Check if the MCP worker is running |
| 5 | Permission denied | Your user role may not have access |

## Error Handling

- **"Not authenticated"** (exit 2) → Run `fastmail auth --url <url>`
- **"Token expired"** (exit 2) → Run `fastmail auth` (re-authenticates, preserves URL)
- **"Invalid ... ID"** (exit 3) → Use IDs from previous command output, not fabricated ones
- **Connection errors** (exit 4) → Check if the MCP worker is running
- **Permission denied** (exit 5) → Your user role may not have access to that tool
- **No browser available** → Use `fastmail auth --headless` for SSH environments

## Agent Safety

- **Always use `--dry-run`** for mutation commands before executing
- **Always use `--fields`** with `--json` to limit response size
- **Use `fastmail describe <tool>`** to discover tool schemas at runtime
- **IDs are opaque** — always use IDs from previous command output, never fabricate them
- **Input is validated** — control characters, path traversal, double-encoding, and embedded query params are rejected
