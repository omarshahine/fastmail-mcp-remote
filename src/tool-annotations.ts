/**
 * MCP tool annotations for every registered tool.
 *
 * Clients with native per-tool approval policies read these hints, so every
 * tool in `TOOL_CATEGORIES` must have an entry here. `registerAllTools` applies
 * this table when a call site passes no explicit annotations.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/server";

const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeAnnotations = (idempotentHint: boolean): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint,
  openWorldHint: false,
});

const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const SEND: ToolAnnotations = {
  title: "Send email",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const entries = (names: string[], annotations: ToolAnnotations): [string, ToolAnnotations][] =>
  names.map((name) => [name, annotations]);

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = Object.fromEntries([
  ...entries(
    [
      "list_mailboxes", "list_emails", "get_email", "search_emails", "get_recent_emails",
      "get_inbox_updates", "get_email_attachments", "download_attachment", "advanced_search",
      "get_thread", "get_memo", "get_mailbox_stats", "get_account_summary", "list_identities",
      "list_contacts", "get_contact", "search_contacts", "list_calendars", "list_calendar_events",
      "get_calendar_event", "check_function_availability",
      "ui_get_send_review", "ui_get_email_view",
    ],
    READ,
  ),
  ...entries(
    ["update_draft", "mark_email_read", "flag_email", "move_email", "bulk_mark_read", "bulk_flag"],
    writeAnnotations(true),
  ),
  // generate_email_action_urls mints bearer archive/delete links, so it is a
  // write even though it does not touch the mailbox itself.
  ...entries(
    ["create_draft", "create_memo", "create_calendar_event", "generate_email_action_urls"],
    writeAnnotations(false),
  ),
  // bulk_move is destructive: on 2026-09-06 a mis-scoped call moved 200 emails.
  ...entries(["delete_email", "delete_memo", "bulk_delete", "bulk_move"], DESTRUCTIVE),
  ...entries(["send_email", "send_copy", "reply_to_email", "forward_email", "ui_approve_send"], SEND),
]);
