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

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { execFileSync } from "node:child_process";
import { registerEmailTools } from "./src/tools/email.js";
import { registerContactTools } from "./src/tools/contacts.js";
import { registerCalendarTools } from "./src/tools/calendar.js";
import { registerMemoTools } from "./src/tools/memo.js";

/** Plugin API type re-exported for tool registration files. */
export type PluginApi = {
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (_id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }, opts?: { optional: boolean }): void;
};

/** Approval config for a tool: severity + human-readable description. */
type ApprovalGate = {
  severity: "info" | "warning" | "critical";
  description: string;
};

/**
 * Tools that require user approval before execution.
 * Keyed by tool name → approval config.
 *
 * - "warning": outbound/irreversible (sends email)
 * - "info": reads untrusted content or bulk state changes
 */
const TOOL_APPROVALS: Record<string, ApprovalGate> = {
  // Outbound — sends email on behalf of user
  fastmail_send_email: { severity: "warning", description: "Send a new email" },
  fastmail_reply_to_email: { severity: "warning", description: "Send a reply" },

  // Reads email content — untrusted data enters agent context
  fastmail_get_email: { severity: "info", description: "Read email body (untrusted content)" },
  fastmail_get_thread: { severity: "info", description: "Read email thread (untrusted content)" },
  fastmail_search_emails: { severity: "info", description: "Search and read emails (untrusted content)" },
  fastmail_download_attachment: { severity: "info", description: "Download email attachment (untrusted content)" },

  // Bulk state changes — higher blast radius
  fastmail_bulk_delete: { severity: "info", description: "Bulk delete emails" },
  fastmail_bulk_move: { severity: "info", description: "Bulk move emails" },
  fastmail_bulk_read: { severity: "info", description: "Bulk mark emails as read" },
  fastmail_bulk_unread: { severity: "info", description: "Bulk mark emails as unread" },
  fastmail_bulk_flag: { severity: "info", description: "Bulk flag emails" },
  fastmail_bulk_unflag: { severity: "info", description: "Bulk unflag emails" },

  // Single delete — irreversible
  fastmail_delete: { severity: "info", description: "Delete an email" },
};

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

/**
 * Query the remote server for disabled categories via `fastmail permissions --json`.
 * Uses execFileSync because OpenClaw's register() must be synchronous.
 * Returns [] on any failure (CLI missing, not authenticated, server down).
 */
function discoverDisabledCategories(cli: string): string[] {
  try {
    const stdout = execFileSync(cli, ["permissions", "--json"], {
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed.disabledCategories) ? parsed.disabledCategories : [];
  } catch {
    return [];
  }
}

/** Wrap the API to silently skip tools whose category is disabled. */
function withCategoryFilter(api: PluginApi, disabled: Set<string>): PluginApi {
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

export default definePluginEntry({
  id: "fastmail-cli",
  name: "Fastmail CLI",
  description: "Email, contacts, and calendar tools via the Fastmail CLI",
  register(api) {
    const cfg = (api as { pluginConfig?: Record<string, unknown> }).pluginConfig ?? {};
    const cli = (cfg?.cliCommand as string) ?? "fastmail";
    const staticDisabled = (cfg?.disabledCategories as string[]) ?? [];
    const autoDiscover = (cfg?.autoDiscover as boolean) ?? true;
    const approvals = (cfg?.requireApprovals as boolean) ?? true;

    const discovered = autoDiscover ? discoverDisabledCategories(cli) : [];
    const disabled = new Set([...staticDisabled, ...discovered]);

    const filtered = withCategoryFilter(api as unknown as PluginApi, disabled);

    registerEmailTools(filtered, cli);
    registerContactTools(filtered, cli);
    registerCalendarTools(filtered, cli);
    registerMemoTools(filtered, cli);

    // Gate sensitive tool calls behind user approval
    if (approvals) {
      // The SDK types registerHook as InternalHookHandler (returns void),
      // but before_tool_call handlers return PluginHookBeforeToolCallResult
      // at runtime. Cast to satisfy the type checker.
      api.registerHook(
        "before_tool_call",
        ((event: { toolName: string; params: Record<string, unknown> }) => {
          const gate = TOOL_APPROVALS[event.toolName];
          if (!gate) return; // not our tool or ungated — abstain

          return {
            requireApproval: {
              title: `Fastmail: ${event.toolName.replace("fastmail_", "")}`,
              description: gate.description,
              severity: gate.severity,
              timeoutMs: 120_000,
              timeoutBehavior: "deny" as const,
            },
          };
        }) as unknown as Parameters<typeof api.registerHook>[1],
        { name: "fastmail-approval-gate" },
      );
    }
  },
});
