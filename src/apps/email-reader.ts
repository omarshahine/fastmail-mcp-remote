/**
 * MCP Apps email reader, shown next to `get_email` and `get_thread` results.
 *
 * Email content never enters the page source: the view reads the tool input
 * (`emailId` or `threadId`), fetches the messages through the app-only
 * `ui_get_email_view` tool, and renders headers with `textContent` and each
 * body in a sandboxed `srcdoc` iframe built by `buildEmailPreviewDocument`.
 *
 * Its actions call the ordinary model-visible tools (`mark_email_read`,
 * `flag_email`, `move_email`), so they go through the same permission checks.
 * "Draft reply" only sends a user message; the model then drafts with
 * `reply_to_email`, which never sends without approval.
 */

import { buildEmailPreviewDocument } from "../email-preview";
import type { ToolContext } from "../tools";
import { renderAppPage, UNMARK_SCRIPT } from "./page";

export interface EmailReaderMessage {
  emailId: string;
  from: string;
  to: string[];
  date: string;
  subject: string;
  seen: boolean;
  flagged: boolean;
  previewDocument: string;
}

export interface EmailReaderView {
  messages: EmailReaderMessage[];
  archiveMailboxId: string | null;
}

function formatAddress(address: any): string {
  if (!address || typeof address !== "object") return "";
  const email = typeof address.email === "string" ? address.email : "";
  const name = typeof address.name === "string" ? address.name.trim() : "";
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

function addresses(value: unknown): string[] {
  return Array.isArray(value) ? value.map(formatAddress).filter(Boolean) : [];
}

function bodyText(email: any, partsKey: "htmlBody" | "textBody"): string {
  const parts = Array.isArray(email?.[partsKey]) ? email[partsKey] : [];
  const values = email?.bodyValues ?? {};
  return parts
    .map((part: any) => (part && typeof values[part.partId]?.value === "string" ? values[part.partId].value : ""))
    .filter(Boolean)
    .join("\n");
}

function toMessage(email: any): EmailReaderMessage {
  const keywords = email?.keywords ?? {};
  return {
    emailId: String(email.id),
    from: addresses(email.from).join(", "),
    to: addresses(email.to),
    date: typeof email.receivedAt === "string" ? email.receivedAt : "",
    subject: typeof email.subject === "string" ? email.subject : "",
    seen: keywords.$seen === true,
    flagged: keywords.$flagged === true,
    previewDocument: buildEmailPreviewDocument(bodyText(email, "htmlBody"), bodyText(email, "textBody")),
  };
}

/**
 * Build the reader data for one email or one thread. JMAP errors propagate so
 * the tool reports them instead of rendering an empty view.
 */
export async function buildEmailReaderView(
  ctx: ToolContext,
  target: { emailId: string } | { threadId: string },
): Promise<EmailReaderView> {
  const client = ctx.getJmapClient();
  const [emails, mailboxes] = await Promise.all([
    "emailId" in target
      ? client.getEmailById(target.emailId).then((email) => [email])
      : client.getThread(target.threadId),
    client.getMailboxes(),
  ]);
  const archive = (mailboxes || []).find((mailbox: any) => mailbox?.role === "archive");
  return {
    messages: emails.filter(Boolean).map(toMessage),
    archiveMailboxId: archive && typeof archive.id === "string" ? archive.id : null,
  };
}

const BODY = `
<style>
  .reader { display: grid; gap: 14px; }
  .message { display: grid; gap: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  .message:last-child { border-bottom: none; padding-bottom: 0; }
  .subject { font-weight: 600; font-size: 15px; margin: 0; }
  .fields { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 0; }
  .fields dt { color: var(--muted); }
  .fields dd { margin: 0; }
  iframe { width: 100%; height: 320px; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .error { color: var(--danger); }
  button:disabled { opacity: 0.6; cursor: default; }
  [hidden] { display: none !important; }
</style>
<div class="reader">
  <p id="message" class="muted">Loading email...</p>
  <div id="messages"></div>
</div>
`;

// Plain inline script (not Function.toString), so esbuild's keepNames cannot
// inject helpers into it. Email fields only reach the DOM through
// `textContent` and the sandboxed iframe's `srcdoc`.
const SCRIPT = `
(function () {
  var app = window.fastmailApp;
  var loaded = false;
  var $ = function (id) { return document.getElementById(id); };
${UNMARK_SCRIPT}
  var setMessage = function (text, isError) {
    var el = $("message");
    el.textContent = text;
    el.className = isError ? "error" : "muted";
    el.hidden = !text;
  };

  var el = function (tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  var failed = function (result) { return !result || result.isError; };

  var formatDate = function (value) {
    var time = Date.parse(value);
    return isNaN(time) ? (value || "") : new Date(time).toLocaleString();
  };

  // Disable while a call is in flight; bridge requests never time out, so
  // the button stays disabled only until that call settles.
  var run = function (button, status, name, args, onSuccess) {
    button.disabled = true;
    status.textContent = "";
    app.callTool(name, args).then(function (result) {
      if (failed(result)) {
        status.textContent = "That action failed.";
        button.disabled = false;
        return;
      }
      button.disabled = false;
      onSuccess();
    }, function () {
      status.textContent = "That action failed.";
      button.disabled = false;
    });
  };

  var renderMessage = function (message, archiveMailboxId) {
    var state = { seen: message.seen === true, flagged: message.flagged === true };
    var item = el("section", "message");
    item.appendChild(el("p", "subject", message.subject || "(no subject)"));

    var fields = el("dl", "fields");
    var field = function (label, value) {
      if (!value) return;
      fields.appendChild(el("dt", "", label));
      fields.appendChild(el("dd", "", value));
    };
    field("From", message.from);
    field("To", (message.to || []).join(", "));
    field("Date", formatDate(message.date));
    item.appendChild(fields);

    var frame = el("iframe");
    frame.setAttribute("sandbox", "");
    frame.setAttribute("title", "Email body");
    frame.srcdoc = message.previewDocument || "";
    item.appendChild(frame);

    var actions = el("div", "actions");
    var status = el("span", "muted error");
    var read = el("button");
    read.type = "button";
    read.setAttribute("data-action", "read");
    var flag = el("button");
    flag.type = "button";
    flag.setAttribute("data-action", "flag");
    var archive = el("button", "", "Archive");
    archive.type = "button";
    archive.setAttribute("data-action", "archive");
    archive.hidden = !archiveMailboxId;
    var reply = el("button", "primary", "Draft reply");
    reply.type = "button";
    reply.setAttribute("data-action", "reply");

    var labels = function () {
      read.textContent = state.seen ? "Mark unread" : "Mark read";
      flag.textContent = state.flagged ? "Unflag" : "Flag";
    };
    labels();

    read.addEventListener("click", function () {
      var next = !state.seen;
      run(read, status, "mark_email_read", { emailId: message.emailId, read: next }, function () {
        state.seen = next;
        labels();
      });
    });
    flag.addEventListener("click", function () {
      var next = !state.flagged;
      run(flag, status, "flag_email", { emailId: message.emailId, flagged: next }, function () {
        state.flagged = next;
        labels();
      });
    });
    archive.addEventListener("click", function () {
      if (!archiveMailboxId) return;
      run(archive, status, "move_email", { emailId: message.emailId, targetMailboxId: archiveMailboxId }, function () {
        archive.textContent = "Archived";
        archive.disabled = true;
      });
    });
    reply.addEventListener("click", function () {
      // Never awaited: the host answers once the model turn is queued.
      var sent = app.sendMessage("Draft a reply to email " + message.emailId);
      if (sent && typeof sent.catch === "function") {
        sent.catch(function () { status.textContent = "Could not ask for a reply draft."; });
      }
    });

    actions.appendChild(read);
    actions.appendChild(flag);
    actions.appendChild(archive);
    actions.appendChild(reply);
    actions.appendChild(status);
    item.appendChild(actions);
    return item;
  };

  var render = function (view) {
    var container = $("messages");
    while (container.firstChild) container.removeChild(container.firstChild);
    var messages = (view && view.messages) || [];
    for (var i = 0; i < messages.length; i++) {
      container.appendChild(renderMessage(messages[i], view.archiveMailboxId || null));
    }
    setMessage(messages.length ? "" : "No messages to show.", false);
  };

  app.onToolInput(function (args) {
    if (loaded || !args) return;
    var request = null;
    if (typeof args.emailId === "string" && args.emailId) request = { emailId: args.emailId };
    else if (typeof args.threadId === "string" && args.threadId) request = { threadId: args.threadId };
    if (!request) {
      setMessage("No email to show.", true);
      return;
    }
    loaded = true;
    app.callTool("ui_get_email_view", request).then(function (result) {
      if (failed(result) || !result.structuredContent) {
        setMessage("This email could not be loaded.", true);
        return;
      }
      render(unmark(result.structuredContent));
    }, function () {
      loaded = false;
      setMessage("This email could not be loaded.", true);
    });
  });
})();
`;

export function renderEmailReaderApp(): string {
  return renderAppPage({ title: "Email", body: BODY, script: SCRIPT });
}
