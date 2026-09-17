import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools, type ToolContext } from "../src/tools";

function registeredTools(client: Record<string, any>) {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const server = {
    tool(...args: any[]) {
      handlers.set(args[0], args[args.length - 1]);
    },
  } as unknown as McpServer;
  const context: ToolContext = {
    env: { SEND_APPROVAL_MODE: "required", WORKER_URL: "https://mail.example.test" } as unknown as Env,
    getCurrentUser: () => "sender@example.com",
    getJmapClient: () => client as any,
    getContactsCalendarClient: vi.fn() as any,
    checkToolPermission: async () => null,
    guardResponse: vi.fn() as any,
  };
  registerAllTools(server, context, new Set(["forward_email", "update_draft", "send_email"]));
  return handlers;
}

function sourceEmail(overrides: Record<string, any> = {}) {
  return {
    id: "source-1",
    subject: "Trip plans",
    from: [{ name: "Alex <Agent>", email: "alex@example.com" }],
    to: [{ name: "Sam", email: "sam@example.com" }],
    cc: [{ email: "team@example.com" }],
    receivedAt: "2026-09-16T21:17:00Z",
    messageId: ["orig@example.com"],
    references: ["root@example.com"],
    textBody: [{ partId: "1", type: "text/plain" }],
    htmlBody: [{ partId: "2", type: "text/html" }],
    bodyValues: {
      "1": { value: "Dear Sam,\nSee attached." },
      "2": { value: "<p>Dear Sam,</p><p>See <b>attached</b>.</p><img src=\"cid:logo\">" },
    },
    attachments: [
      { blobId: "blob-pdf", type: "application/pdf", name: "brochure.pdf", size: 1000, disposition: "attachment" },
      { blobId: "blob-logo", type: "image/png", name: "logo.png", size: 10, cid: "logo", disposition: "inline" },
    ],
    ...overrides,
  };
}

describe("forward_email", () => {
  it("drafts a forward with a line-per-field header, the original HTML, and its attachments", async () => {
    const client = {
      getEmailById: vi.fn().mockResolvedValue(sourceEmail()),
      createDraft: vi.fn().mockResolvedValue("draft-fwd"),
      sendEmail: vi.fn(),
    };
    const handler = registeredTools(client).get("forward_email")!;
    const result = await handler({
      emailId: "source-1",
      to: ["lora@example.com"],
      markdownBody: "Take a look.\n\nLove,\nOmar",
      includeAttachments: true,
      sendImmediately: false,
    }, {});

    expect(result.content[0].text).toContain("Forward draft created successfully. Draft ID: draft-fwd");
    expect(client.sendEmail).not.toHaveBeenCalled();
    const draft = client.createDraft.mock.calls[0][0];

    expect(draft.subject).toBe("Fwd: Trip plans");
    expect(draft.to).toEqual(["lora@example.com"]);
    expect(draft.references).toEqual(["root@example.com", "orig@example.com"]);
    expect(draft).not.toHaveProperty("inReplyTo");

    // Single newlines in Markdown stay line breaks.
    expect(draft.htmlBody).toContain("Love,<br>Omar");
    // Each header field on its own line, third-party values escaped.
    expect(draft.htmlBody).toContain("---------- Forwarded message ----------<br>");
    expect(draft.htmlBody).toContain("<b>From:</b> Alex &lt;Agent&gt; &lt;alex@example.com&gt;<br>");
    expect(draft.htmlBody).toContain("<b>Date:</b> Wed, Sep 16, 2026, 9:17 PM UTC<br>");
    expect(draft.htmlBody).toContain("<b>Subject:</b> Trip plans<br>");
    expect(draft.htmlBody).toContain("<b>To:</b> Sam &lt;sam@example.com&gt;<br>");
    expect(draft.htmlBody).toContain("<b>Cc:</b> team@example.com<br>");
    // Original body carried verbatim, not re-rendered.
    expect(draft.htmlBody).toContain("<p>See <b>attached</b>.</p><img src=\"cid:logo\">");

    expect(draft.textBody.startsWith("Take a look.\n\nLove,\nOmar\n\n---------- Forwarded message ----------\nFrom: Alex <Agent> <alex@example.com>\n")).toBe(true);
    expect(draft.textBody).toContain("To: Sam <sam@example.com>\nCc: team@example.com\n\nDear Sam,\nSee attached.");

    expect(draft.existingAttachments).toEqual([
      { blobId: "blob-pdf", type: "application/pdf", name: "brochure.pdf", size: 1000, disposition: "attachment" },
      { blobId: "blob-logo", type: "image/png", name: "logo.png", size: 10, cid: "logo", disposition: "inline" },
    ]);
  });

  it("keeps inline images but drops file attachments when includeAttachments is false", async () => {
    const client = {
      getEmailById: vi.fn().mockResolvedValue(sourceEmail()),
      createDraft: vi.fn().mockResolvedValue("draft-fwd"),
    };
    const handler = registeredTools(client).get("forward_email")!;
    await handler({ emailId: "source-1", to: ["x@example.com"], includeAttachments: false, sendImmediately: false }, {});

    expect(client.createDraft.mock.calls[0][0].existingAttachments.map((a: any) => a.blobId)).toEqual(["blob-logo"]);
  });

  it("does not double-prefix the subject and never leaks HTML-only markup into the text part", async () => {
    const client = {
      getEmailById: vi.fn().mockResolvedValue(sourceEmail({
        subject: "FW: Newsletter",
        textBody: [{ partId: "2", type: "text/html" }],
        htmlBody: [{ partId: "2", type: "text/html" }],
        bodyValues: { "2": { value: "<p>Hello <b>world</b></p>" } },
        attachments: [],
      })),
      createDraft: vi.fn().mockResolvedValue("draft-fwd"),
    };
    const handler = registeredTools(client).get("forward_email")!;
    await handler({ emailId: "source-1", to: ["x@example.com"], body: "FYI", includeAttachments: true, sendImmediately: false }, {});

    const draft = client.createDraft.mock.calls[0][0];
    expect(draft.subject).toBe("FW: Newsletter");
    expect(draft.textBody.startsWith("FYI\n\n---------- Forwarded message ----------")).toBe(true);
    expect(draft.textBody).toContain("Hello **world**");
    expect(draft.textBody).not.toContain("<p>");
    expect(draft.htmlBody).toContain("<p>Hello <b>world</b></p>");
  });

  it("routes sendImmediately through the approval gate instead of sending directly", async () => {
    const client = {
      getEmailById: vi.fn().mockResolvedValue(sourceEmail()),
      createDraft: vi.fn().mockResolvedValue("draft-fwd"),
      getDraftApprovalSnapshot: vi.fn().mockRejectedValue(new Error("approval store reached")),
      sendEmail: vi.fn(),
    };
    const handler = registeredTools(client).get("forward_email")!;
    const result = await handler({ emailId: "source-1", to: ["x@example.com"], includeAttachments: true, sendImmediately: true }, {});

    expect(client.createDraft).toHaveBeenCalledOnce();
    expect(client.getDraftApprovalSnapshot).toHaveBeenCalledWith("draft-fwd");
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Failed to forward email");
  });
});

describe("markdown bodies", () => {
  it("keep single newlines as line breaks in send_email", async () => {
    const client = {
      createDraft: vi.fn().mockResolvedValue("draft-1"),
      getDraftApprovalSnapshot: vi.fn().mockRejectedValue(new Error("stop")),
    };
    const handler = registeredTools(client).get("send_email")!;
    await handler({ to: ["x@example.com"], subject: "Hi", markdownBody: "Love,\nOmar" }, {});
    expect(client.createDraft.mock.calls[0][0].htmlBody).toContain("Love,<br>Omar");
  });
});

describe("update_draft on a forward draft", () => {
  async function createForwardDraft(original: any) {
    const client = { getEmailById: vi.fn().mockResolvedValue(original), createDraft: vi.fn().mockResolvedValue("draft-fwd") };
    await registeredTools(client).get("forward_email")!({
      emailId: "source-1", to: ["x@example.com"], body: "Old note", includeAttachments: true, sendImmediately: false,
    }, {});
    const created = client.createDraft.mock.calls[0][0];
    return {
      id: "draft-fwd",
      subject: created.subject,
      keywords: { $draft: true },
      inReplyTo: null,
      references: created.references ?? null,
      textBody: [{ partId: "t", type: "text/plain" }],
      htmlBody: [{ partId: "h", type: "text/html" }],
      bodyValues: { t: { value: created.textBody }, h: { value: created.htmlBody } },
    };
  }

  function editClient(draft: any) {
    return {
      getEmailById: vi.fn().mockResolvedValue(draft),
      getEmailByMessageId: vi.fn(),
      updateDraft: vi.fn().mockResolvedValue("draft-fwd-2"),
    };
  }

  it("keeps the forwarded block from the draft itself, without looking up the original", async () => {
    // Original without a Message-ID: References would point at its parent, and a
    // lookup could not find it anyway.
    const draft = await createForwardDraft(sourceEmail({ messageId: null }));
    const client = editClient(draft);
    const result = await registeredTools(client).get("update_draft")!({ draftId: "draft-fwd", body: "New note", excludeQuote: false }, {});

    expect(client.getEmailByMessageId).not.toHaveBeenCalled();
    const update = client.updateDraft.mock.calls[0][0];
    expect(update.textBody).toBe("New note" + draft.bodyValues.t.value.slice("Old note".length));
    expect(update.textBody).not.toContain("Old note");
    expect(update.htmlBody).not.toContain("Old note");
    expect(update.htmlBody).toContain("<b>From:</b> Alex &lt;Agent&gt; &lt;alex@example.com&gt;<br>");
    expect(update.htmlBody).toContain("<p>See <b>attached</b>.</p>");
    expect(result.content[0].text).toContain("Forwarded message preserved beneath your message.");
  });

  it("survives repeated edits and forwarded mail that itself contains a forward", async () => {
    const nested = sourceEmail({
      bodyValues: {
        "1": { value: "Hi\n\n---------- Forwarded message ----------\nFrom: someone" },
        "2": { value: "<p>Hi</p>\n<br><br>\n<div>---------- Forwarded message ----------<br>\n<b>From:</b> someone" },
      },
    });
    let draft = await createForwardDraft(nested);
    for (const note of ["Second", "Third"]) {
      const client = editClient(draft);
      await registeredTools(client).get("update_draft")!({ draftId: draft.id, body: note, excludeQuote: false }, {});
      const update = client.updateDraft.mock.calls[0][0];
      draft = { ...draft, bodyValues: { t: { value: update.textBody }, h: { value: update.htmlBody } } };
    }
    expect(draft.bodyValues.t.value.startsWith("Third\n\n---------- Forwarded message ----------\nFrom: Alex")).toBe(true);
    expect(draft.bodyValues.t.value).toContain("Hi\n\n---------- Forwarded message ----------\nFrom: someone");
    expect(draft.bodyValues.h.value).toContain("<b>From:</b> someone");
    expect(draft.bodyValues.h.value).not.toContain("Second");
  });

  it("drops the forwarded block only when excludeQuote is true", async () => {
    const draft = await createForwardDraft(sourceEmail());
    const client = editClient(draft);
    await registeredTools(client).get("update_draft")!({ draftId: "draft-fwd", body: "Just this", excludeQuote: true }, {});
    expect(client.updateDraft.mock.calls[0][0].textBody).toBe("Just this");
  });
});
