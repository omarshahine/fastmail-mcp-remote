/**
 * MCP Apps send review card, shown next to `send_email`, `send_copy`,
 * `reply_to_email` and `forward_email` results.
 *
 * The card is a read-only preview. It cannot approve anything: its only
 * action is `ui/open-link` to the Access-authenticated `/approve/send/:id`
 * page, which is the sole place a send is approved. Email content never enters
 * the page source; the view fetches it through the app-only
 * `ui_get_send_review` tool and renders it with `textContent` and a sandboxed
 * `srcdoc` iframe.
 */

import { approvalUrl, getSendApproval, type SendApprovalRecord } from "../send-approval";
import { buildEmailPreviewDocument } from "../email-preview";
import type { ToolContext } from "../tools";
import { renderAppPage } from "./page";

export interface SendReviewView {
  approvalId: string;
  status: SendApprovalRecord["status"];
  expiresAt: string;
  reviewUrl: string;
  toolName: SendApprovalRecord["toolName"];
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Sanitized, script-free preview document for a sandboxed iframe; "" when the draft is gone. */
  previewDocument: string;
}

/**
 * Build the review card data for `approvalId`. Returns `null` when the record
 * is missing or belongs to another user, so callers cannot tell the two apart.
 */
export async function buildSendReviewView(
  ctx: ToolContext,
  approvalId: string,
): Promise<SendReviewView | null> {
  const currentUser = ctx.getCurrentUser();
  if (!currentUser) return null;
  const record = await getSendApproval(ctx.env, approvalId);
  if (!record || record.userLogin.toLowerCase() !== currentUser.toLowerCase()) return null;

  const view: SendReviewView = {
    approvalId: record.id,
    status: record.status,
    expiresAt: record.expiresAt,
    reviewUrl: approvalUrl(ctx.env, record.id),
    toolName: record.toolName,
    from: "",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    previewDocument: "",
  };

  // Once sent (or deleted) the email is no longer a draft and the snapshot
  // read fails. The card still needs the status, so report it without content.
  try {
    const snapshot = await ctx.getJmapClient().getDraftApprovalSnapshot(record.draftId);
    view.from = snapshot.from;
    view.to = snapshot.to;
    view.cc = snapshot.cc;
    view.bcc = snapshot.bcc;
    view.subject = snapshot.subject;
    view.previewDocument = buildEmailPreviewDocument(snapshot.htmlBody, snapshot.textBody);
  } catch {
    // Status-only view.
  }
  return view;
}

const BODY = `
<style>
  .card { display: grid; gap: 10px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .badge { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); }
  .badge[data-status="sent"] { color: var(--accent); border-color: var(--accent); }
  .badge[data-status="declined"], .badge[data-status="expired"] { color: var(--danger); border-color: var(--danger); }
  .fields { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 0; }
  .fields dt { color: var(--muted); }
  .fields dd { margin: 0; }
  .subject { font-weight: 600; font-size: 15px; margin: 0; }
  iframe { width: 100%; height: 320px; border: 1px solid var(--border); border-radius: 8px; background: #fff; }
  .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  [hidden] { display: none !important; }
</style>
<div class="card">
  <div class="head">
    <strong>Email review</strong>
    <span id="status" class="badge" data-status="loading">Loading</span>
  </div>
  <p id="message" class="muted">Waiting for the draft...</p>
  <dl id="fields" class="fields" hidden>
    <dt>From</dt><dd id="from"></dd>
    <dt>To</dt><dd id="to"></dd>
    <dt id="cc-label">Cc</dt><dd id="cc"></dd>
    <dt id="bcc-label">Bcc</dt><dd id="bcc"></dd>
  </dl>
  <p id="subject" class="subject" hidden></p>
  <iframe id="preview" sandbox="" title="Email preview" hidden></iframe>
  <div class="actions">
    <button id="approve" class="primary" type="button" hidden>Review &amp; approve</button>
    <span id="hint" class="muted" hidden>Approval happens on the secure Fastmail review page.</span>
  </div>
  <p id="link" class="muted" hidden></p>
</div>
`;

// Plain inline script (not Function.toString), so esbuild's keepNames cannot
// inject helpers into it. Only `textContent`, `srcdoc` and attribute writes
// touch the DOM; the iframe is sandboxed with no permissions.
const SCRIPT = `
(function () {
  var app = window.fastmailApp;
  var POLL_MS = 5000;
  var LABELS = { pending: "Awaiting approval", approved: "Sending", sending: "Sending", sent: "Sent", declined: "Declined", expired: "Expired" };
  var current = null;
  var timer = null;
  var rendered = false;
  var $ = function (id) { return document.getElementById(id); };

  var show = function (id, visible) { $(id).hidden = !visible; };
  var list = function (values) { return (values || []).join(", "); };

  var setStatus = function (status) {
    var badge = $("status");
    badge.setAttribute("data-status", status);
    badge.textContent = LABELS[status] || status;
    var pending = status === "pending";
    show("approve", pending);
    show("hint", pending);
    if (!pending) show("link", false);
  };

  var setMessage = function (text) {
    $("message").textContent = text;
    show("message", !!text);
  };

  var renderContent = function (view) {
    if (rendered || !view.previewDocument) return;
    rendered = true;
    $("from").textContent = view.from;
    $("to").textContent = list(view.to);
    $("cc").textContent = list(view.cc);
    $("bcc").textContent = list(view.bcc);
    show("cc-label", view.cc && view.cc.length > 0);
    show("cc", view.cc && view.cc.length > 0);
    show("bcc-label", view.bcc && view.bcc.length > 0);
    show("bcc", view.bcc && view.bcc.length > 0);
    show("fields", true);
    $("subject").textContent = view.subject || "(no subject)";
    show("subject", true);
    $("preview").srcdoc = view.previewDocument;
    show("preview", true);
  };

  var expired = function (view) {
    var expiresAt = Date.parse(view.expiresAt);
    return !isNaN(expiresAt) && Date.now() >= expiresAt;
  };

  var apply = function (view) {
    current = view;
    renderContent(view);
    var status = view.status;
    // The store marks a lapsed approval expired on its next read; show it now.
    if (status === "pending" && expired(view)) status = "expired";
    setStatus(status);
    setMessage(rendered ? "" : "The draft is no longer available to preview.");
    if (timer) clearTimeout(timer);
    timer = null;
    if (status === "pending") timer = setTimeout(refresh, POLL_MS);
  };

  var refresh = function () {
    if (!current) return;
    app.callTool("ui_get_send_review", { approvalId: current.approvalId }).then(function (result) {
      if (!result || result.isError || !result.structuredContent) {
        setMessage("This approval could not be loaded.");
        return;
      }
      apply(result.structuredContent);
    }, function () {
      // Transient bridge failure: keep the last view and try again.
      if (current && current.status === "pending" && !expired(current)) {
        timer = setTimeout(refresh, POLL_MS);
      }
    });
  };

  $("approve").addEventListener("click", function () {
    if (!current) return;
    var url = current.reviewUrl;
    // Bridge requests never time out, so never await this to re-enable the
    // button. Show the link as text in case the host refuses to open it.
    app.openLink(url).catch(function () {
      $("link").textContent = "Open this link to review and approve: " + url;
      show("link", true);
    });
  });

  app.onToolResult(function (result) {
    var data = result && result.structuredContent;
    if (!data || typeof data.approvalId !== "string") {
      setStatus("unknown");
      $("status").textContent = "No approval";
      setMessage("This result has no email awaiting approval.");
      return;
    }
    current = { approvalId: data.approvalId, status: data.status, expiresAt: data.expiresAt, reviewUrl: data.reviewUrl };
    setStatus(data.status);
    refresh();
  });
})();
`;

export function renderSendReviewApp(): string {
  return renderAppPage({ title: "Email review", body: BODY, script: SCRIPT });
}
