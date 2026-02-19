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
fastmail auth status   # Check token validity
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

## Error Handling

- **"Not authenticated"** → Run `fastmail auth --url <url>`
- **"Token expired"** → Run `fastmail auth` (re-authenticates, preserves URL)
- **Connection errors** → Check if the MCP worker is running
- **Permission denied** → Your user role may not have access to that tool
