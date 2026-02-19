# Fastmail Tools

Token-efficient tools for Fastmail email, contacts, and calendar. Each tool shells out to the `fastmail` CLI and returns compact text optimized for LLM token efficiency (5-7x savings vs raw JSON).

## Authentication

Tools require the `fastmail` CLI to be installed and authenticated:

```bash
fastmail auth --url https://your-worker.example.com --team myteam
```

Tokens last 30 days. Re-run `fastmail auth` when expired.

## Available Tools

### Email Reading (11 tools)

| Tool | Purpose |
|------|---------|
| `fastmail_inbox` | Get recent inbox emails (IDs, dates, senders, subjects, previews) |
| `fastmail_get_email` | Read a single email (headers + body in markdown or HTML) |
| `fastmail_search_emails` | Search emails by text, with optional filters: sender, recipient, date range, unread, attachments, mailbox |
| `fastmail_get_thread` | Get all emails in a conversation thread |
| `fastmail_list_mailboxes` | List all mailboxes with IDs and email counts |
| `fastmail_get_mailbox_stats` | Get mailbox statistics (total, unread, threads) |
| `fastmail_get_account_summary` | Account overview with counts |
| `fastmail_list_identities` | List sending identities |
| `fastmail_get_attachments` | List attachments for an email |
| `fastmail_download_attachment` | Get download URL for an attachment |
| `fastmail_get_inbox_updates` | Incremental sync: get changes since a state token |

### Email Writing (3 optional tools)

| Tool | Purpose |
|------|---------|
| `fastmail_send_email` | Send an email (text, HTML, or markdown body) |
| `fastmail_create_draft` | Create an email draft |
| `fastmail_reply_to_email` | Reply to an email (reply-all, send or draft) |

### Email Organization (6 optional tools)

| Tool | Purpose |
|------|---------|
| `fastmail_mark_read` | Mark email as read |
| `fastmail_mark_unread` | Mark email as unread |
| `fastmail_flag` | Flag (star) an email |
| `fastmail_unflag` | Unflag (unstar) an email |
| `fastmail_delete` | Delete an email (move to trash) |
| `fastmail_move` | Move email to a different mailbox |

### Bulk Operations (6 optional tools)

| Tool | Purpose |
|------|---------|
| `fastmail_bulk_read` | Mark multiple emails as read |
| `fastmail_bulk_unread` | Mark multiple emails as unread |
| `fastmail_bulk_flag` | Flag multiple emails |
| `fastmail_bulk_unflag` | Unflag multiple emails |
| `fastmail_bulk_delete` | Delete multiple emails |
| `fastmail_bulk_move` | Move multiple emails to a mailbox |

### Contacts (3 tools)

| Tool | Purpose |
|------|---------|
| `fastmail_list_contacts` | List contacts with names, emails, phones |
| `fastmail_get_contact` | Full contact details |
| `fastmail_search_contacts` | Search contacts by name or email |

### Calendar (4 tools)

| Tool | Purpose |
|------|---------|
| `fastmail_list_calendars` | List calendars with IDs |
| `fastmail_list_events` | List events, optionally by calendar |
| `fastmail_get_event` | Full event details |
| `fastmail_create_event` | Create a calendar event (optional) |

### Memos (3 tools)

| Tool | Purpose |
|------|---------|
| `fastmail_get_memo` | Get the private memo on an email |
| `fastmail_create_memo` | Add a private memo to an email (optional) |
| `fastmail_delete_memo` | Delete a memo (optional) |

## Output Format

Tools return compact text optimized for LLM consumption. Email IDs appear first on each line for easy extraction.

### Email List Example
```
# inbox (10)

M1234abc  2026-02-19 10:30  *John Smith <john@example.com>
  Re: Project Update -- Preview of the email content...

M5678def  2026-02-19 09:15   Jane Doe <jane@example.com> [att]
  Contract Review -- Please review the attached...
```

Indicators: `*` = unread, `!` = flagged, `[att]` = has attachments

### Single Email Example
```
From: John Smith <john@example.com>
To: me@example.com
Date: 2026-02-19 10:30
Subject: Re: Project Update
ID: M1234abc | Thread: T5678

[markdown body content]
```

## Common Workflows

### Check inbox and read an email
1. `fastmail_inbox` -- see list, note IDs
2. `fastmail_get_email` with the ID -- read the email

### Search, read, and reply
1. `fastmail_search_emails` with query
2. `fastmail_get_email` with the ID
3. `fastmail_reply_to_email` with body and `send: true`

### Triage inbox
1. `fastmail_inbox` with limit 20
2. `fastmail_bulk_read` for read emails
3. `fastmail_delete` for unwanted emails
4. `fastmail_move` to archive

### Incremental sync
1. `fastmail_get_inbox_updates` (no state token) -- returns current state + emails
2. Save the `queryState` from the response
3. `fastmail_get_inbox_updates` with `sinceQueryState` -- only changes since last check

## Error Handling

- **"Not authenticated"** -- User needs to run `fastmail auth --url <url>`
- **"Token expired"** -- User needs to run `fastmail auth`
- **Connection errors** -- Check if the MCP worker is running
