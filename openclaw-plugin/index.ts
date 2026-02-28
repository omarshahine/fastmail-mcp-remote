/**
 * OpenClaw plugin entry point for Fastmail.
 *
 * Registers agent tools that shell out to the `fastmail` CLI.
 * The CLI handles MCP connection, auth, and compact text formatting.
 * Zero runtime dependencies — just execFile to the CLI process.
 *
 * Supports `disabledCategories` config to skip tools whose server-side
 * category is disabled, so agents only see tools they can actually use.
 */

import { registerEmailTools } from "./src/tools/email.js";
import { registerContactTools } from "./src/tools/contacts.js";
import { registerCalendarTools } from "./src/tools/calendar.js";
import { registerMemoTools } from "./src/tools/memo.js";

/** Minimal typed interface for the OpenClaw plugin API. */
export interface OpenClawApi {
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (_id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }, opts?: { optional: boolean }): void;
  config?: Record<string, unknown>;
}

/**
 * Map every plugin tool name to its server-side permission category.
 * Categories must match the ToolCategory type in src/permissions.ts.
 */
const TOOL_CATEGORIES: Record<string, string> = {
  // EMAIL_READ
  fastmail_inbox: "EMAIL_READ",
  fastmail_get_email: "EMAIL_READ",
  fastmail_search_emails: "EMAIL_READ",
  fastmail_get_thread: "EMAIL_READ",
  fastmail_list_mailboxes: "EMAIL_READ",
  fastmail_get_mailbox_stats: "EMAIL_READ",
  fastmail_get_account_summary: "EMAIL_READ",
  fastmail_list_identities: "EMAIL_READ",
  fastmail_get_attachments: "EMAIL_READ",
  fastmail_download_attachment: "EMAIL_READ",
  fastmail_get_inbox_updates: "EMAIL_READ",
  fastmail_get_memo: "EMAIL_READ",

  // CONTACTS
  fastmail_list_contacts: "CONTACTS",
  fastmail_get_contact: "CONTACTS",
  fastmail_search_contacts: "CONTACTS",

  // CALENDAR_READ
  fastmail_list_calendars: "CALENDAR_READ",
  fastmail_list_events: "CALENDAR_READ",
  fastmail_get_event: "CALENDAR_READ",

  // CALENDAR_WRITE
  fastmail_create_event: "CALENDAR_WRITE",

  // INBOX_MANAGE
  fastmail_mark_read: "INBOX_MANAGE",
  fastmail_mark_unread: "INBOX_MANAGE",
  fastmail_flag: "INBOX_MANAGE",
  fastmail_unflag: "INBOX_MANAGE",
  fastmail_delete: "INBOX_MANAGE",
  fastmail_move: "INBOX_MANAGE",
  fastmail_bulk_read: "INBOX_MANAGE",
  fastmail_bulk_unread: "INBOX_MANAGE",
  fastmail_bulk_flag: "INBOX_MANAGE",
  fastmail_bulk_unflag: "INBOX_MANAGE",
  fastmail_bulk_delete: "INBOX_MANAGE",
  fastmail_bulk_move: "INBOX_MANAGE",
  fastmail_create_memo: "INBOX_MANAGE",
  fastmail_delete_memo: "INBOX_MANAGE",

  // DRAFT
  fastmail_create_draft: "DRAFT",

  // REPLY
  fastmail_reply_to_email: "REPLY",

  // SEND
  fastmail_send_email: "SEND",
};

/** Wrap the API to silently skip tools whose category is disabled. */
function withCategoryFilter(api: OpenClawApi, disabled: Set<string>): OpenClawApi {
  if (disabled.size === 0) return api;
  return {
    ...api,
    registerTool(tool, opts) {
      const category = TOOL_CATEGORIES[tool.name];
      if (category && disabled.has(category)) return;
      api.registerTool(tool, opts);
    },
  };
}

export default function register(api: OpenClawApi) {
  const cli = (api.config?.cliCommand as string) ?? "fastmail";
  const disabledList = (api.config?.disabledCategories as string[]) ?? [];
  const disabled = new Set(disabledList);

  const filtered = withCategoryFilter(api, disabled);

  registerEmailTools(filtered, cli);
  registerContactTools(filtered, cli);
  registerCalendarTools(filtered, cli);
  registerMemoTools(filtered, cli);
}
