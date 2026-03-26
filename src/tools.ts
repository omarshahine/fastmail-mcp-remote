/**
 * Extracted tool registration for Fastmail MCP server.
 *
 * All 29+ MCP tools are registered via `registerAllTools()` on any McpServer instance.
 * This enables reuse: the Durable Object path (FastmailMCP.init()) and the Code Mode
 * endpoint (/mcp/code) both call this with different ToolContext implementations.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { marked } from "marked";
import { formatEmailAsMarkdown } from "./html-to-markdown";
import { FastmailAuth } from "./fastmail-auth";
import { JmapClient } from "./jmap-client";
import { ContactsCalendarClient } from "./contacts-calendar";
import { getPermissionsConfig, getUserConfig, getVisibleTools, isToolAllowed, TOOL_CATEGORIES } from "./permissions";
import { markToolResult, markUntrustedText, isExternalDataTool, getDatamarkingPreamble } from "./prompt-guard";
import { generateActionUrls } from "./action-urls";
import {
  formatEmailList,
  formatMailboxes,
  formatMailboxStats,
  formatAccountSummary,
  formatContacts,
  formatContact,
  formatCalendars,
  formatEvents,
  formatIdentities,
  formatMemo,
  formatAttachments,
  formatInboxUpdates,
  flattenEmailList,
} from "./formatters";

/** Tools that return email lists where addresses can be flattened (Alt C) */
const EMAIL_LIST_TOOLS = new Set([
  "list_emails",
  "search_emails",
  "get_recent_emails",
  "advanced_search",
]);

/** Standard MCP tool result shape */
export type ToolResult = { content: { text: string; type: "text" }[] };

/** Guard response options for compact formatting */
export interface GuardOptions {
  compact?: boolean;
  compactFormatter?: (data: any) => string;
}

/**
 * Context required by tool handlers. Abstracts away whether tools run inside
 * a Durable Object (FastmailMCP) or a standalone McpServer (Code Mode).
 */
export interface ToolContext {
  env: Env;
  getCurrentUser: () => string | null;
  getJmapClient: () => JmapClient;
  getContactsCalendarClient: () => ContactsCalendarClient;
  checkToolPermission: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => Promise<ToolResult | null>;
  guardResponse: (toolName: string, data: unknown, options?: GuardOptions) => ToolResult;
}

/**
 * Build a ToolContext from environment and token info, for use outside the
 * Durable Object (e.g., the /mcp/code endpoint).
 */
export function buildToolContext(env: Env, userLogin: string): ToolContext {
  return {
    env,
    getCurrentUser: () => userLogin,
    getJmapClient: () => new JmapClient(new FastmailAuth({ apiToken: env.FASTMAIL_API_TOKEN })),
    getContactsCalendarClient: () => new ContactsCalendarClient(new FastmailAuth({ apiToken: env.FASTMAIL_API_TOKEN })),
    checkToolPermission: async (toolName, args) => {
      const config = await getPermissionsConfig(env.OAUTH_KV);
      const userConfig = getUserConfig(config, userLogin);
      const result = isToolAllowed(userConfig, toolName, args);
      if (!result.allowed) {
        return { content: [{ text: `Error: ${result.error}`, type: "text" }] };
      }
      return null;
    },
    guardResponse: (toolName, data, options) => guardResponse(toolName, data, options),
  };
}

/**
 * Standalone guardResponse implementation (mirrors FastmailMCP.guardResponse).
 * Wraps tool responses with prompt injection datamarking and optional compact formatting.
 */
export function guardResponse(
  toolName: string,
  data: unknown,
  options?: GuardOptions,
): ToolResult {
  if (options?.compact && options.compactFormatter) {
    const text = options.compactFormatter(data);
    if (isExternalDataTool(toolName)) {
      const preamble = getDatamarkingPreamble();
      return { content: [{ text: `${preamble}\n\n${text}`, type: "text" }] };
    }
    return { content: [{ text, type: "text" }] };
  }

  let processedData = data;
  if (Array.isArray(data) && EMAIL_LIST_TOOLS.has(toolName)) {
    processedData = flattenEmailList(data as any[]);
  }

  if (isExternalDataTool(toolName)) {
    const preamble = getDatamarkingPreamble();
    const marked = markToolResult(processedData, toolName);
    const json = JSON.stringify(marked);
    return { content: [{ text: `${preamble}\n\n${json}`, type: "text" }] };
  }
  const json = JSON.stringify(processedData);
  return { content: [{ text: json, type: "text" }] };
}

/**
 * Ask the MCP client to confirm an email send via elicitation.
 *
 * Uses `extra.sendRequest` (not `server.elicitInput`) so the elicitation request
 * is routed via the tool call's POST response stream instead of requiring a
 * standalone GET/SSE stream. This makes it work with Claude Code's HTTP transport.
 *
 * Returns { approved: true } if confirmed or client doesn't support elicitation (fail-open).
 * Returns { approved: false, message } if declined or cancelled.
 */
async function confirmSend(
  extra: any,
  details: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    bodyPreview: string;
    isReply?: boolean;
  },
): Promise<{ approved: boolean; message?: string }> {
  try {
    const lines = [
      details.isReply ? "Confirm Reply" : "Confirm Send",
      "",
      `To: ${details.to.join(", ")}`,
    ];
    if (details.cc?.length) lines.push(`CC: ${details.cc.join(", ")}`);
    if (details.bcc?.length) lines.push(`BCC: ${details.bcc.join(", ")}`);
    lines.push(`Subject: ${details.subject}`);
    lines.push("");
    const preview = details.bodyPreview.length > 500
      ? details.bodyPreview.slice(0, 500) + "..."
      : details.bodyPreview;
    lines.push(preview);

    const result = await extra.sendRequest(
      {
        method: "elicitation/create" as const,
        params: {
          message: lines.join("\n"),
          mode: "form" as const,
          requestedSchema: {
            type: "object" as const,
            required: ["confirm"],
            properties: {
              confirm: {
                type: "boolean" as const,
                title: "Send this email?",
                description: "Uncheck to cancel sending",
                default: true,
              },
            },
          },
        },
      },
      ElicitResultSchema,
      { timeout: 60000 }, // 60s timeout for user to respond to confirmation dialog
    );

    if (result.action === "accept" && result.content?.confirm === true) {
      return { approved: true };
    }
    const reason = result.action === "decline" ? "User declined"
      : result.action === "cancel" ? "User cancelled"
      : "Send not confirmed";
    return { approved: false, message: reason };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Fail-open ONLY when the client doesn't support elicitation at all.
    // This preserves backward compatibility with older MCP clients.
    // Match the exact MCP SDK error messages from Server.elicitInput():
    //   "Client does not support form elicitation."
    //   "Client does not support url elicitation."
    if (msg.includes("Client does not support")) {
      console.warn(`[elicitation] Client does not support elicitation (fail-open): ${msg}`);
      return { approved: true };
    }

    // For timeouts, disconnects, or any other error: fail-closed (don't send).
    // This prevents emails from sending when the user declines or the connection drops.
    console.warn(`[elicitation] Elicitation failed (fail-closed): ${msg}`);
    return { approved: false, message: `Confirmation failed: ${msg}` };
  }
}

/**
 * Register all Fastmail MCP tools on the given server.
 *
 * @param server - McpServer instance to register tools on
 * @param ctx - ToolContext providing env, clients, permissions, and response formatting
 * @param visibleTools - Optional set of tool names to register. If provided, tools not in the set are skipped.
 */
export function registerAllTools(
  server: McpServer,
  ctx: ToolContext,
  visibleTools?: Set<string>,
): void {
  /** Helper: skip tool if not in visibleTools set */
  const shouldRegister = (name: string) => !visibleTools || visibleTools.has(name);

  // =====================
  // EMAIL TOOLS
  // =====================

  if (shouldRegister("list_mailboxes")) {
    server.tool(
      "list_mailboxes",
      "List all mailboxes in the Fastmail account. Use format='compact' for token-efficient text output.",
      {
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ format }) => {
        const client = ctx.getJmapClient();
        const mailboxes = await client.getMailboxes();
        return ctx.guardResponse("list_mailboxes", mailboxes, {
          compact: format === "compact",
          compactFormatter: formatMailboxes,
        });
      },
    );
  }

  if (shouldRegister("list_emails")) {
    server.tool(
      "list_emails",
      "List emails from a mailbox. Use format='compact' for token-efficient text output.",
      {
        mailboxId: z.string().optional().describe("ID of the mailbox to list emails from (optional, defaults to all)"),
        limit: z.number().default(20).describe("Maximum number of emails to return (default: 20)"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ mailboxId, limit, format }) => {
        const client = ctx.getJmapClient();
        const emails = await client.getEmails(mailboxId, limit);
        return ctx.guardResponse("list_emails", emails, {
          compact: format === "compact",
          compactFormatter: (data) => formatEmailList(data, "Emails"),
        });
      },
    );
  }

  if (shouldRegister("get_email")) {
    server.tool(
      "get_email",
      "Get a specific email by ID. Returns LLM-friendly markdown by default (converts HTML to clean markdown, strips tracking pixels and layout noise). Use format='html' to get the raw JMAP JSON when you need to inspect original HTML.",
      {
        emailId: z.string().describe("ID of the email to retrieve"),
        format: z
          .enum(["markdown", "html"])
          .default("markdown")
          .describe("Output format: 'markdown' (default) returns clean readable text, 'html' returns raw JMAP JSON"),
      },
      async ({ emailId, format }) => {
        const client = ctx.getJmapClient();
        const email = await client.getEmailById(emailId);
        if (format === "html") {
          return ctx.guardResponse("get_email", email);
        }
        const preamble = getDatamarkingPreamble();
        const markdown = markUntrustedText(formatEmailAsMarkdown(email), "mail.body");
        return {
          content: [{ text: `${preamble}\n\n${markdown}`, type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("send_email")) {
    server.tool(
      "send_email",
      "Send an email. Supports file attachments via base64-encoded content. For replies, set inReplyTo and references from the original email.",
      {
        to: z.array(z.string()).describe("Recipient email addresses"),
        cc: z.array(z.string()).optional().describe("CC email addresses (optional)"),
        bcc: z.array(z.string()).optional().describe("BCC email addresses (optional)"),
        from: z.string().optional().describe("Sender email address (optional, defaults to account primary email)"),
        subject: z.string().describe("Email subject"),
        textBody: z.string().optional().describe("Plain text body (optional)"),
        htmlBody: z.string().optional().describe("HTML body (optional)"),
        markdownBody: z
          .string()
          .optional()
          .describe("Markdown body (optional). Converted to HTML automatically. Takes precedence over htmlBody if both provided."),
        attachments: z
          .array(
            z.object({
              filename: z.string().describe("Filename for the attachment (e.g., 'report.pdf')"),
              mimeType: z.string().describe("MIME type (e.g., 'application/pdf', 'image/png')"),
              content: z.string().describe("Base64-encoded file content"),
            }),
          )
          .optional()
          .describe("File attachments (optional). Each attachment needs filename, mimeType, and base64 content. Max 25MB per file."),
        inReplyTo: z
          .array(z.string())
          .optional()
          .describe("Message-ID(s) this email is replying to. Get from original email's messageId field."),
        references: z
          .array(z.string())
          .optional()
          .describe("Message-ID chain for threading. Combine original email's references with its messageId."),
      },
      async ({ to, cc, bcc, from, subject, textBody, htmlBody, markdownBody, attachments, inReplyTo, references }, extra) => {
        // DEFENSE-IN-DEPTH: Block delegates even if the outer Hono check is bypassed
        const denied = await ctx.checkToolPermission('send_email');
        if (denied) return denied;

        if (!textBody && !htmlBody && !markdownBody) {
          return {
            content: [{ text: "Error: Either textBody, htmlBody, or markdownBody is required", type: "text" }],
          };
        }

        // Elicitation: ask user to confirm before sending
        const bodyPreview = textBody || markdownBody || (htmlBody ? htmlBody.replace(/<[^>]*>/g, "") : "");
        const confirmation = await confirmSend(extra, { to, cc, bcc, subject, bodyPreview });
        if (!confirmation.approved) {
          return {
            content: [{ text: `Email not sent: ${confirmation.message || "cancelled by user"}`, type: "text" }],
          };
        }

        try {
          const client = ctx.getJmapClient();
          const finalHtmlBody = markdownBody ? await marked.parse(markdownBody) : htmlBody;
          const submissionId = await client.sendEmail({
            to,
            cc,
            bcc,
            from,
            subject,
            textBody,
            htmlBody: finalHtmlBody,
            attachments,
            inReplyTo,
            references,
          });
          const attachmentCount = attachments?.length || 0;
          const attachmentNote = attachmentCount > 0 ? ` with ${attachmentCount} attachment(s)` : "";
          const replyNote = inReplyTo ? " (reply)" : "";
          return {
            content: [{ text: `Email sent successfully${attachmentNote}${replyNote}. Submission ID: ${submissionId}`, type: "text" }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ text: `Failed to send email: ${errorMessage}`, type: "text" }],
          };
        }
      },
    );
  }

  if (shouldRegister("create_draft")) {
    server.tool(
      "create_draft",
      "Create an email draft in the Drafts folder without sending it. Supports file attachments via base64-encoded content. For reply drafts, set inReplyTo and references from the original email.",
      {
        to: z.array(z.string()).describe("Recipient email addresses"),
        cc: z.array(z.string()).optional().describe("CC email addresses (optional)"),
        bcc: z.array(z.string()).optional().describe("BCC email addresses (optional)"),
        from: z.string().optional().describe("Sender email address (optional, defaults to account primary email)"),
        subject: z.string().describe("Email subject"),
        textBody: z.string().optional().describe("Plain text body (optional)"),
        htmlBody: z.string().optional().describe("HTML body (optional)"),
        markdownBody: z
          .string()
          .optional()
          .describe("Markdown body (optional). Converted to HTML automatically. Takes precedence over htmlBody if both provided."),
        attachments: z
          .array(
            z.object({
              filename: z.string().describe("Filename for the attachment (e.g., 'report.pdf')"),
              mimeType: z.string().describe("MIME type (e.g., 'application/pdf', 'image/png')"),
              content: z.string().describe("Base64-encoded file content"),
            }),
          )
          .optional()
          .describe("File attachments (optional). Each attachment needs filename, mimeType, and base64 content. Max 25MB per file."),
        inReplyTo: z
          .array(z.string())
          .optional()
          .describe("Message-ID(s) this email is replying to. Get from original email's messageId field."),
        references: z
          .array(z.string())
          .optional()
          .describe("Message-ID chain for threading. Combine original email's references with its messageId."),
      },
      async ({ to, cc, bcc, from, subject, textBody, htmlBody, markdownBody, attachments, inReplyTo, references }) => {
        if (!textBody && !htmlBody && !markdownBody) {
          return {
            content: [{ text: "Error: Either textBody, htmlBody, or markdownBody is required", type: "text" }],
          };
        }
        try {
          const client = ctx.getJmapClient();
          const finalHtmlBody = markdownBody ? await marked.parse(markdownBody) : htmlBody;
          const draftId = await client.createDraft({
            to,
            cc,
            bcc,
            from,
            subject,
            textBody,
            htmlBody: finalHtmlBody,
            attachments,
            inReplyTo,
            references,
          });
          const attachmentCount = attachments?.length || 0;
          const attachmentNote = attachmentCount > 0 ? ` with ${attachmentCount} attachment(s)` : "";
          const replyNote = inReplyTo ? " (reply)" : "";
          return {
            content: [
              { text: `Draft created successfully${attachmentNote}${replyNote} in Drafts folder. Draft ID: ${draftId}`, type: "text" },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ text: `Failed to create draft: ${errorMessage}`, type: "text" }],
          };
        }
      },
    );
  }

  if (shouldRegister("reply_to_email")) {
    server.tool(
      "reply_to_email",
      "Reply to an email with proper threading and quoting, just like Fastmail's reply button. Automatically handles recipients, subject, threading headers, and quotes the original message.",
      {
        emailId: z.string().describe("ID of the email to reply to"),
        body: z.string().describe("Your reply message (plain text)"),
        htmlBody: z.string().optional().describe("Your reply message (HTML, optional). If not provided, plain text body is used."),
        markdownBody: z
          .string()
          .optional()
          .describe(
            "Your reply message (Markdown, optional). Converted to HTML automatically. Takes precedence over htmlBody if both provided.",
          ),
        from: z
          .string()
          .optional()
          .describe("Sender email address (optional, defaults to account primary email). Use list_identities to see available aliases."),
        replyAll: z.boolean().default(false).describe("If true, reply to all recipients (sender + CC). Default is reply to sender only."),
        sendImmediately: z.boolean().default(false).describe("If true, send the reply immediately. If false (default), create a draft."),
        excludeQuote: z.boolean().default(false).describe("If true, don't include quoted original message. Default includes quote."),
      },
      async ({ emailId, body, htmlBody, markdownBody, from, replyAll, sendImmediately, excludeQuote }, extra) => {
        // DEFENSE-IN-DEPTH: Block delegates from sending replies immediately
        if (sendImmediately) {
          const denied = await ctx.checkToolPermission('reply_to_email', { sendImmediately: true });
          if (denied) return denied;
        }

        try {
          const client = ctx.getJmapClient();
          const original = await client.getEmailById(emailId);

          if (!original) {
            return {
              content: [{ text: `Error: Email with ID '${emailId}' not found`, type: "text" }],
            };
          }

          const replyToAddrs = original.replyTo || original.from || [];
          if (replyToAddrs.length === 0) {
            return {
              content: [{ text: `Error: Cannot reply - email has no sender address`, type: "text" }],
            };
          }
          const toRecipients = replyToAddrs.map((addr: any) => addr.email);
          const toRecipientsLower = toRecipients.map((e: string) => e.toLowerCase());

          let ccRecipients: string[] = [];
          if (replyAll) {
            const userEmail = await client.getUserEmail();
            const allOriginalRecipients = [...(original.to || []), ...(original.cc || [])];
            ccRecipients = allOriginalRecipients
              .map((addr: any) => addr.email)
              .filter(
                (email: string) => email.toLowerCase() !== userEmail.toLowerCase() && !toRecipientsLower.includes(email.toLowerCase()),
              );
          }

          let subject = original.subject || "";
          if (!subject.match(/^Re:/i)) {
            subject = `Re: ${subject}`;
          }

          const inReplyTo = original.messageId || [];
          const references = [...(original.references || []), ...(original.messageId || [])];

          let quotedText = "";
          let quotedHtml = "";

          if (!excludeQuote) {
            const originalFrom = original.from?.[0];
            const senderName = originalFrom?.name || originalFrom?.email || "Unknown";
            const senderEmail = originalFrom?.email || "";

            const receivedDate = new Date(original.receivedAt);
            const dateStr = receivedDate.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            });
            const timeStr = receivedDate.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });

            const bodyValues = original.bodyValues as Record<string, { value: string }> | undefined;
            const textPartId = original.textBody?.[0]?.partId;
            const htmlPartId = original.htmlBody?.[0]?.partId;
            const originalTextBody =
              (textPartId && bodyValues?.[textPartId]?.value) || (bodyValues ? Object.values(bodyValues)[0]?.value : "") || "";

            const quotedLines = originalTextBody
              .split("\n")
              .map((line: string) => `> ${line}`)
              .join("\n");
            quotedText = `\n\nOn ${dateStr}, at ${timeStr}, ${senderName} <${senderEmail}> wrote:\n\n${quotedLines}`;

            const originalHtmlBody = (htmlPartId && bodyValues?.[htmlPartId]?.value) || "";

            const quotedContent =
              originalHtmlBody ||
              `<pre style="white-space: pre-wrap; font-family: inherit;">${originalTextBody.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;

            quotedHtml = `
<br><br>
<div style="color: #666;">On ${dateStr}, at ${timeStr}, ${senderName} &lt;${senderEmail}&gt; wrote:</div>
<blockquote type="cite" style="margin: 10px 0 0 0; padding: 0 0 0 10px; border-left: 2px solid #ccc;">
${quotedContent}
</blockquote>`;
          }

          const finalTextBody = body + quotedText;
          const replyHtml = markdownBody ? await marked.parse(markdownBody) : htmlBody;
          const finalHtmlBody = replyHtml
            ? `<div>${replyHtml}</div>${quotedHtml}`
            : `<div style="white-space: pre-wrap;">${body.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>${quotedHtml}`;

          if (sendImmediately) {
            // Elicitation: ask user to confirm before sending reply
            const replyConfirmation = await confirmSend(extra, {
              to: toRecipients,
              cc: ccRecipients.length > 0 ? ccRecipients : undefined,
              subject,
              bodyPreview: body,
              isReply: true,
            });
            if (!replyConfirmation.approved) {
              return {
                content: [{ text: `Reply not sent: ${replyConfirmation.message || "cancelled by user"}`, type: "text" }],
              };
            }

            const submissionId = await client.sendEmail({
              to: toRecipients,
              cc: ccRecipients.length > 0 ? ccRecipients : undefined,
              from,
              subject,
              textBody: finalTextBody,
              htmlBody: finalHtmlBody,
              inReplyTo,
              references,
            });
            return {
              content: [
                {
                  text: `Reply sent successfully. Submission ID: ${submissionId}\nTo: ${toRecipients.join(", ")}${ccRecipients.length > 0 ? `\nCC: ${ccRecipients.join(", ")}` : ""}`,
                  type: "text",
                },
              ],
            };
          } else {
            const draftId = await client.createDraft({
              to: toRecipients,
              cc: ccRecipients.length > 0 ? ccRecipients : undefined,
              from,
              subject,
              textBody: finalTextBody,
              htmlBody: finalHtmlBody,
              inReplyTo,
              references,
            });
            return {
              content: [
                {
                  text: `Reply draft created successfully. Draft ID: ${draftId}\nTo: ${toRecipients.join(", ")}${ccRecipients.length > 0 ? `\nCC: ${ccRecipients.join(", ")}` : ""}\nSubject: ${subject}`,
                  type: "text",
                },
              ],
            };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ text: `Failed to create reply: ${errorMessage}`, type: "text" }],
          };
        }
      },
    );
  }

  if (shouldRegister("search_emails")) {
    server.tool(
      "search_emails",
      "Search emails by subject or content. Use format='compact' for token-efficient text output.",
      {
        query: z.string().describe("Search query string"),
        limit: z.number().default(20).describe("Maximum number of results (default: 20)"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ query, limit, format }) => {
        const client = ctx.getJmapClient();
        const emails = await client.searchEmails(query, limit);
        return ctx.guardResponse("search_emails", emails, {
          compact: format === "compact",
          compactFormatter: (data) => formatEmailList(data, `Search: ${query}`),
        });
      },
    );
  }

  if (shouldRegister("get_recent_emails")) {
    server.tool(
      "get_recent_emails",
      "Get the most recent emails from inbox (like top-ten). Use format='compact' for token-efficient text output.",
      {
        limit: z.number().default(10).describe("Number of recent emails to retrieve (default: 10, max: 50)"),
        mailboxName: z.string().default("inbox").describe("Mailbox to search (default: inbox)"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ limit, mailboxName, format }) => {
        const client = ctx.getJmapClient();
        const emails = await client.getRecentEmails(limit, mailboxName);
        return ctx.guardResponse("get_recent_emails", emails, {
          compact: format === "compact",
          compactFormatter: (data) => formatEmailList(data, `Recent: ${mailboxName}`),
        });
      },
    );
  }

  if (shouldRegister("get_inbox_updates")) {
    server.tool(
      "get_inbox_updates",
      "Get inbox changes since a previous state. Returns only new/removed emails for incremental sync. On first call (no sinceQueryState), returns all inbox emails with a state token for future incremental calls.",
      {
        sinceQueryState: z.string().optional().describe("Opaque JMAP query state token from a previous call. Omit for full fetch."),
        mailboxId: z.string().optional().describe("Mailbox ID to query (auto-discovers Inbox if omitted)"),
        limit: z.number().default(100).describe("Maximum number of emails to return (default: 100)"),
      },
      async ({ sinceQueryState, mailboxId, limit }) => {
        try {
          const client = ctx.getJmapClient();
          const result = await client.getInboxUpdates({ sinceQueryState, mailboxId, limit });
          return {
            content: [{ text: JSON.stringify(result), type: "text" }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ text: `Failed to get inbox updates: ${errorMessage}`, type: "text" }],
          };
        }
      },
    );
  }

  if (shouldRegister("mark_email_read")) {
    server.tool(
      "mark_email_read",
      "Mark an email as read or unread",
      {
        emailId: z.string().describe("ID of the email to mark"),
        read: z.boolean().default(true).describe("true to mark as read, false to mark as unread"),
      },
      async ({ emailId, read }) => {
        const client = ctx.getJmapClient();
        await client.markEmailRead(emailId, read);
        return {
          content: [{ text: `Email ${read ? "marked as read" : "marked as unread"} successfully`, type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("flag_email")) {
    server.tool(
      "flag_email",
      "Flag or unflag an email (starred/important marker)",
      {
        emailId: z.string().describe("ID of the email to flag/unflag"),
        flagged: z.boolean().default(true).describe("true to flag, false to unflag"),
      },
      async ({ emailId, flagged }) => {
        const client = ctx.getJmapClient();
        await client.flagEmail(emailId, flagged);
        return {
          content: [{ text: `Email ${flagged ? "flagged" : "unflagged"} successfully`, type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("delete_email")) {
    server.tool(
      "delete_email",
      "Delete an email (move to trash)",
      {
        emailId: z.string().describe("ID of the email to delete"),
      },
      async ({ emailId }) => {
        const client = ctx.getJmapClient();
        await client.deleteEmail(emailId);
        return {
          content: [{ text: "Email deleted successfully (moved to trash)", type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("move_email")) {
    server.tool(
      "move_email",
      "Move an email to a different mailbox",
      {
        emailId: z.string().describe("ID of the email to move"),
        targetMailboxId: z.string().describe("ID of the target mailbox"),
      },
      async ({ emailId, targetMailboxId }) => {
        const client = ctx.getJmapClient();
        await client.moveEmail(emailId, targetMailboxId);
        return {
          content: [{ text: "Email moved successfully", type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("get_email_attachments")) {
    server.tool(
      "get_email_attachments",
      "Get list of attachments for an email",
      {
        emailId: z.string().describe("ID of the email"),
      },
      async ({ emailId }) => {
        const client = ctx.getJmapClient();
        const attachments = await client.getEmailAttachments(emailId);
        return ctx.guardResponse("get_email_attachments", attachments);
      },
    );
  }

  if (shouldRegister("download_attachment")) {
    server.tool(
      "download_attachment",
      "Download an email attachment. Returns a temporary download URL that can be used with curl (no auth required). The URL is single-use and expires after 5 minutes.",
      {
        emailId: z.string().describe("ID of the email"),
        attachmentId: z.string().describe("ID of the attachment"),
        inline: z
          .boolean()
          .default(false)
          .describe("If true, returns base64-encoded content inline instead of a download URL. Only for small files (<1MB)."),
      },
      async ({ emailId, attachmentId, inline }) => {
        const client = ctx.getJmapClient();
        try {
          const metadata = await client.getAttachmentMetadata(emailId, attachmentId);

          if (inline) {
            if (metadata.size > 1024 * 1024) {
              return {
                content: [
                  {
                    text: `Attachment is too large for inline (${Math.round(metadata.size / 1024)}KB). Use the default download URL instead.`,
                    type: "text",
                  },
                ],
              };
            }
            const attachmentContent = await client.fetchAttachmentContent(emailId, attachmentId);
            return {
              content: [{ text: JSON.stringify(attachmentContent), type: "text" }],
            };
          }

          const token = crypto.randomUUID();
          await ctx.env.OAUTH_KV.put(
            `download:${token}`,
            JSON.stringify({
              downloadUrl: metadata.downloadUrl,
              filename: metadata.filename,
              mimeType: metadata.mimeType,
              size: metadata.size,
            }),
            { expirationTtl: 300 },
          );

          const baseUrl = ctx.env.WORKER_URL || "http://localhost:8788";
          const proxyUrl = `${baseUrl}/download/${token}`;

          return {
            content: [
              {
                text: JSON.stringify(
                  {
                    filename: metadata.filename,
                    mimeType: metadata.mimeType,
                    size: metadata.size,
                    downloadUrl: proxyUrl,
                    curl: `curl -o "${metadata.filename}" "${proxyUrl}"`,
                    note: "URL is single-use and expires in 5 minutes",
                  },
                  null,
                  2,
                ),
                type: "text",
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ text: `Attachment download failed: ${errorMessage}`, type: "text" }],
          };
        }
      },
    );
  }

  if (shouldRegister("advanced_search")) {
    server.tool(
      "advanced_search",
      "Advanced email search with multiple criteria. Use format='compact' for token-efficient text output.",
      {
        query: z.string().optional().describe("Text to search for in subject/body"),
        from: z.string().optional().describe("Filter by sender email"),
        to: z.string().optional().describe("Filter by recipient email"),
        subject: z.string().optional().describe("Filter by subject"),
        hasAttachment: z.boolean().optional().describe("Filter emails with attachments"),
        isUnread: z.boolean().optional().describe("Filter unread emails"),
        mailboxId: z.string().optional().describe("Search within specific mailbox"),
        after: z.string().optional().describe("Emails after this date (ISO 8601)"),
        before: z.string().optional().describe("Emails before this date (ISO 8601)"),
        limit: z.number().default(50).describe("Maximum results (default: 50)"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async (filters) => {
        const client = ctx.getJmapClient();
        const emails = await client.advancedSearch(filters);
        return ctx.guardResponse("advanced_search", emails, {
          compact: filters.format === "compact",
          compactFormatter: (data) => formatEmailList(data, "Search Results"),
        });
      },
    );
  }

  if (shouldRegister("get_thread")) {
    server.tool(
      "get_thread",
      "Get all emails in a conversation thread. Returns LLM-friendly markdown by default (converts HTML to clean markdown, strips tracking pixels and layout noise). Use format='html' to get the raw JMAP JSON when you need to inspect original HTML.",
      {
        threadId: z.string().describe("ID of the thread/conversation"),
        format: z
          .enum(["markdown", "html"])
          .default("markdown")
          .describe("Output format: 'markdown' (default) returns clean readable text, 'html' returns raw JMAP JSON"),
      },
      async ({ threadId, format }) => {
        const client = ctx.getJmapClient();
        try {
          const thread = await client.getThread(threadId);
          if (format === "html") {
            return ctx.guardResponse("get_thread", thread);
          }
          const preamble = getDatamarkingPreamble();
          const formatted = thread.map((email: any) => formatEmailAsMarkdown(email)).join("\n\n---\n\n");
          const markedText = markUntrustedText(formatted, "mail.thread");
          return {
            content: [{ text: `${preamble}\n\n${markedText}`, type: "text" }],
          };
        } catch (error) {
          return {
            content: [{ text: `Thread access failed: ${error instanceof Error ? error.message : String(error)}`, type: "text" }],
          };
        }
      },
    );
  }

  // =====================
  // MEMO TOOLS
  // =====================

  if (shouldRegister("create_memo")) {
    server.tool(
      "create_memo",
      "Add a private memo (note) to an email. Memos are personal annotations visible only to you, stored in Fastmail's Memos folder. Useful for reminders, tracking payment dates, or jotting notes about a conversation.",
      {
        emailId: z.string().describe("ID of the email to attach the memo to"),
        text: z.string().describe("The memo text (plain text)"),
      },
      async ({ emailId, text }) => {
        try {
          const client = ctx.getJmapClient();
          const result = await client.createMemo(emailId, text);
          return {
            content: [{ text: `Memo created successfully on "${result.subject}". Memo ID: ${result.memoId}`, type: "text" }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ text: `Failed to create memo: ${errorMessage}`, type: "text" }],
          };
        }
      },
    );
  }

  if (shouldRegister("get_memo")) {
    server.tool(
      "get_memo",
      "Get the memo (private note) attached to an email, if one exists. Returns the memo text, creation date, and memo ID.",
      {
        emailId: z.string().describe("ID of the email to check for a memo"),
      },
      async ({ emailId }) => {
        try {
          const client = ctx.getJmapClient();
          const memo = await client.getMemo(emailId);
          if (!memo) {
            return {
              content: [{ text: "No memo found for this email.", type: "text" }],
            };
          }
          return ctx.guardResponse("get_memo", memo);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ text: `Failed to get memo: ${errorMessage}`, type: "text" }],
          };
        }
      },
    );
  }

  if (shouldRegister("delete_memo")) {
    server.tool(
      "delete_memo",
      "Delete the memo (private note) attached to an email.",
      {
        emailId: z.string().describe("ID of the email whose memo should be deleted"),
      },
      async ({ emailId }) => {
        try {
          const client = ctx.getJmapClient();
          const deleted = await client.deleteMemo(emailId);
          if (!deleted) {
            return {
              content: [{ text: "No memo found for this email.", type: "text" }],
            };
          }
          return {
            content: [{ text: "Memo deleted successfully.", type: "text" }],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ text: `Failed to delete memo: ${errorMessage}`, type: "text" }],
          };
        }
      },
    );
  }

  if (shouldRegister("get_mailbox_stats")) {
    server.tool(
      "get_mailbox_stats",
      "Get statistics for a mailbox (unread count, total emails, etc.). Use format='compact' for token-efficient text output.",
      {
        mailboxId: z.string().optional().describe("ID of the mailbox (optional, defaults to all mailboxes)"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ mailboxId, format }) => {
        const client = ctx.getJmapClient();
        const stats = await client.getMailboxStats(mailboxId);
        return ctx.guardResponse("get_mailbox_stats", stats, {
          compact: format === "compact",
          compactFormatter: formatMailboxStats,
        });
      },
    );
  }

  if (shouldRegister("get_account_summary")) {
    server.tool(
      "get_account_summary",
      "Get overall account summary with statistics. Use format='compact' for token-efficient text output.",
      {
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ format }) => {
        const client = ctx.getJmapClient();
        const summary = await client.getAccountSummary();
        if (format === "compact") {
          return { content: [{ text: formatAccountSummary(summary), type: "text" }] };
        }
        return {
          content: [{ text: JSON.stringify(summary), type: "text" }],
        };
      },
    );
  }

  // =====================
  // BULK EMAIL OPERATIONS
  // =====================

  if (shouldRegister("bulk_mark_read")) {
    server.tool(
      "bulk_mark_read",
      "Mark multiple emails as read/unread",
      {
        emailIds: z.array(z.string()).describe("Array of email IDs to mark"),
        read: z.boolean().default(true).describe("true to mark as read, false as unread"),
      },
      async ({ emailIds, read }) => {
        const client = ctx.getJmapClient();
        await client.bulkMarkRead(emailIds, read);
        return {
          content: [{ text: `${emailIds.length} emails ${read ? "marked as read" : "marked as unread"} successfully`, type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("bulk_move")) {
    server.tool(
      "bulk_move",
      "Move multiple emails to a mailbox",
      {
        emailIds: z.array(z.string()).describe("Array of email IDs to move"),
        targetMailboxId: z.string().describe("ID of target mailbox"),
      },
      async ({ emailIds, targetMailboxId }) => {
        const client = ctx.getJmapClient();
        await client.bulkMove(emailIds, targetMailboxId);
        return {
          content: [{ text: `${emailIds.length} emails moved successfully`, type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("bulk_delete")) {
    server.tool(
      "bulk_delete",
      "Delete multiple emails (move to trash)",
      {
        emailIds: z.array(z.string()).describe("Array of email IDs to delete"),
      },
      async ({ emailIds }) => {
        const client = ctx.getJmapClient();
        await client.bulkDelete(emailIds);
        return {
          content: [{ text: `${emailIds.length} emails deleted successfully (moved to trash)`, type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("bulk_flag")) {
    server.tool(
      "bulk_flag",
      "Flag or unflag multiple emails",
      {
        emailIds: z.array(z.string()).describe("Array of email IDs to flag/unflag"),
        flagged: z.boolean().default(true).describe("true to flag, false to unflag"),
      },
      async ({ emailIds, flagged }) => {
        const client = ctx.getJmapClient();
        const result = await client.bulkFlag(emailIds, flagged);
        const action = flagged ? "flagged" : "unflagged";
        let message = `${result.processed} email(s) ${action} successfully`;
        if (result.failed.length > 0) {
          const failureDetails = result.failed.map((f) => `${f.id} (${f.error})`).join(", ");
          message += `. ${result.failed.length} failed: ${failureDetails}`;
        }
        return {
          content: [{ text: message, type: "text" }],
        };
      },
    );
  }

  // =====================
  // IDENTITY TOOLS
  // =====================

  if (shouldRegister("list_identities")) {
    server.tool(
      "list_identities",
      "List sending identities (email addresses that can be used for sending). Use format='compact' for token-efficient text output.",
      {
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ format }) => {
        const client = ctx.getJmapClient();
        const identities = await client.getIdentities();
        if (format === "compact") {
          return { content: [{ text: formatIdentities(identities), type: "text" }] };
        }
        return {
          content: [{ text: JSON.stringify(identities), type: "text" }],
        };
      },
    );
  }

  // =====================
  // CONTACTS TOOLS
  // =====================

  if (shouldRegister("list_contacts")) {
    server.tool(
      "list_contacts",
      "List contacts from the address book. Use format='compact' for token-efficient text output.",
      {
        limit: z.number().default(50).describe("Maximum number of contacts to return (default: 50)"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ limit, format }) => {
        const client = ctx.getContactsCalendarClient();
        const contacts = await client.getContacts(limit);
        return ctx.guardResponse("list_contacts", contacts, {
          compact: format === "compact",
          compactFormatter: formatContacts,
        });
      },
    );
  }

  if (shouldRegister("get_contact")) {
    server.tool(
      "get_contact",
      "Get a specific contact by ID. Use format='compact' for token-efficient text output.",
      {
        contactId: z.string().describe("ID of the contact to retrieve"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ contactId, format }) => {
        const client = ctx.getContactsCalendarClient();
        const contact = await client.getContactById(contactId);
        return ctx.guardResponse("get_contact", contact, {
          compact: format === "compact",
          compactFormatter: formatContact,
        });
      },
    );
  }

  if (shouldRegister("search_contacts")) {
    server.tool(
      "search_contacts",
      "Search contacts by name or email. Use format='compact' for token-efficient text output.",
      {
        query: z.string().describe("Search query string"),
        limit: z.number().default(20).describe("Maximum number of results (default: 20)"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ query, limit, format }) => {
        const client = ctx.getContactsCalendarClient();
        const contacts = await client.searchContacts(query, limit);
        return ctx.guardResponse("search_contacts", contacts, {
          compact: format === "compact",
          compactFormatter: formatContacts,
        });
      },
    );
  }

  // =====================
  // CALENDAR TOOLS
  // =====================

  if (shouldRegister("list_calendars")) {
    server.tool(
      "list_calendars",
      "List all calendars. Use format='compact' for token-efficient text output.",
      {
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ format }) => {
        const client = ctx.getContactsCalendarClient();
        const calendars = await client.getCalendars();
        return ctx.guardResponse("list_calendars", calendars, {
          compact: format === "compact",
          compactFormatter: formatCalendars,
        });
      },
    );
  }

  if (shouldRegister("list_calendar_events")) {
    server.tool(
      "list_calendar_events",
      "List events from a calendar. Use format='compact' for token-efficient text output.",
      {
        calendarId: z.string().optional().describe("ID of the calendar (optional, defaults to all calendars)"),
        limit: z.number().default(50).describe("Maximum number of events to return (default: 50)"),
        format: z.enum(["json", "compact"]).default("json").describe("Output format: 'json' (default) or 'compact' for token-efficient text"),
      },
      async ({ calendarId, limit, format }) => {
        const client = ctx.getContactsCalendarClient();
        const events = await client.getCalendarEvents(calendarId, limit);
        return ctx.guardResponse("list_calendar_events", events, {
          compact: format === "compact",
          compactFormatter: formatEvents,
        });
      },
    );
  }

  if (shouldRegister("get_calendar_event")) {
    server.tool(
      "get_calendar_event",
      "Get a specific calendar event by ID",
      {
        eventId: z.string().describe("ID of the event to retrieve"),
      },
      async ({ eventId }) => {
        const client = ctx.getContactsCalendarClient();
        const event = await client.getCalendarEventById(eventId);
        return ctx.guardResponse("get_calendar_event", event);
      },
    );
  }

  if (shouldRegister("create_calendar_event")) {
    server.tool(
      "create_calendar_event",
      "Create a new calendar event",
      {
        calendarId: z.string().describe("ID of the calendar to create the event in"),
        title: z.string().describe("Event title"),
        description: z.string().optional().describe("Event description (optional)"),
        start: z.string().describe("Start time in ISO 8601 format"),
        end: z.string().describe("End time in ISO 8601 format"),
        location: z.string().optional().describe("Event location (optional)"),
        participants: z
          .array(
            z.object({
              email: z.string(),
              name: z.string().optional(),
            }),
          )
          .optional()
          .describe("Event participants (optional)"),
      },
      async ({ calendarId, title, description, start, end, location, participants }) => {
        const client = ctx.getContactsCalendarClient();
        const eventId = await client.createCalendarEvent({
          calendarId,
          title,
          description,
          start,
          end,
          location,
          participants,
        });
        return {
          content: [{ text: `Calendar event created successfully. Event ID: ${eventId}`, type: "text" }],
        };
      },
    );
  }

  // =====================
  // UTILITY TOOLS
  // =====================

  if (shouldRegister("generate_email_action_urls")) {
    server.tool(
      "generate_email_action_urls",
      "Generate signed action URLs for email archive/delete operations. " +
        "Returns pre-signed URLs that can be embedded in HTML pages to perform " +
        "email actions without requiring authentication. URLs expire after 24 hours.",
      {
        emailIds: z.array(z.string()).describe("Array of email IDs to generate URLs for"),
        archiveMailboxId: z.string().describe("Target mailbox ID for archive action (e.g., Archive folder ID)"),
      },
      async ({ emailIds, archiveMailboxId }) => {
        const denied = await ctx.checkToolPermission("generate_email_action_urls");
        if (denied) return denied;

        const workerUrl = ctx.env.WORKER_URL;
        const urls = await generateActionUrls(emailIds, archiveMailboxId, workerUrl, ctx.env.ACTION_SIGNING_KEY, ctx.env.OAUTH_KV);
        return {
          content: [{ text: JSON.stringify(urls), type: "text" }],
        };
      },
    );
  }

  if (shouldRegister("check_function_availability")) {
    server.tool(
      "check_function_availability",
      "Check which MCP functions are available based on account permissions",
      {},
      async () => {
        const client = ctx.getJmapClient();
        const session = await client.getSession();

        let toolsVisible: Set<string>;
        let userRole: string = 'unknown';
        const currentUser = ctx.getCurrentUser();
        if (currentUser) {
          const config = await getPermissionsConfig(ctx.env.OAUTH_KV);
          const userConfig = getUserConfig(config, currentUser);
          toolsVisible = getVisibleTools(userConfig);
          userRole = userConfig.role;
        } else {
          toolsVisible = new Set(Object.keys(TOOL_CATEGORIES));
        }

        const filterTools = (tools: string[]) => tools.filter((t) => toolsVisible.has(t));

        const allEmailFunctions = [
          "list_mailboxes",
          "list_emails",
          "get_email",
          "send_email",
          "create_draft",
          "search_emails",
          "get_recent_emails",
          "get_inbox_updates",
          "mark_email_read",
          "flag_email",
          "delete_email",
          "move_email",
          "get_email_attachments",
          "download_attachment",
          "advanced_search",
          "get_thread",
          "get_mailbox_stats",
          "get_account_summary",
          "bulk_mark_read",
          "bulk_move",
          "bulk_delete",
          "bulk_flag",
          "create_memo",
          "get_memo",
          "delete_memo",
          "generate_email_action_urls",
          "reply_to_email",
          "list_identities",
        ];

        const allContactsFunctions = ["list_contacts", "get_contact", "search_contacts"];
        const allCalendarFunctions = ["list_calendars", "list_calendar_events", "get_calendar_event", "create_calendar_event"];

        const emailFunctions = filterTools(allEmailFunctions);
        const contactsFunctions = filterTools(allContactsFunctions);
        const calendarFunctions = filterTools(allCalendarFunctions);

        const availability = {
          email: {
            available: emailFunctions.length > 0,
            functions: emailFunctions,
          },
          identity: {
            available: toolsVisible.has("list_identities"),
            functions: filterTools(["list_identities"]),
          },
          contacts: {
            available: contactsFunctions.length > 0 && !!session.capabilities["urn:ietf:params:jmap:contacts"],
            functions: contactsFunctions,
            note: !session.capabilities["urn:ietf:params:jmap:contacts"]
              ? "Contacts access not available - may require enabling in Fastmail account settings"
              : contactsFunctions.length === 0
                ? "Contacts are disabled for your account"
                : "Contacts are available",
          },
          calendar: {
            available: calendarFunctions.length > 0 && !!session.capabilities["urn:ietf:params:jmap:calendars"],
            functions: calendarFunctions,
            note: !session.capabilities["urn:ietf:params:jmap:calendars"]
              ? "Calendar access not available - may require enabling in Fastmail account settings"
              : calendarFunctions.length === 0
                ? "Calendar is disabled for your account"
                : "Calendar is available",
          },
          capabilities: Object.keys(session.capabilities),
          authenticatedUser: currentUser || "authenticated via OAuth",
          role: userRole,
        };

        return {
          content: [{ text: JSON.stringify(availability), type: "text" }],
        };
      },
    );
  }
}
