import { describe, expect, it } from "vitest";
import {
  formatAccountSummary,
  formatAttachments,
  formatContact,
  formatEmailList,
  formatEvents,
  formatMailboxes,
} from "../src/formatters";

describe("server compact formatter scalar hardening", () => {
  it("keeps email metadata on its intended lines", () => {
    const output = formatEmailList([{
      id: "email-1",
      receivedAt: "2026-09-04T12:00:00Z",
      from: [{ name: "Alice\n# Forged", email: "a@example.com\r\nState: stolen" }],
      subject: "Hello\n# Injected",
      preview: "Preview\r\nRemoved: everything",
      keywords: {},
    }]);

    expect(output).not.toContain("\n# Forged");
    expect(output).not.toContain("\n# Injected");
    expect(output).not.toContain("\nRemoved:");
    expect(output).toContain("Alice # Forged");
  });

  it("normalizes free text across mailbox, contact, event, and attachment rows", () => {
    const outputs = [
      formatMailboxes([{ id: "mb", name: "Inbox\n# Fake", totalEmails: 1 }]),
      formatAccountSummary({ mailboxCount: 1, identityCount: 1, totalEmails: 1, unreadEmails: 0, mailboxes: [{ name: "Inbox\r\nState: fake", totalEmails: 1 }] }),
      formatContact({ name: "Alice\nAdmin", notes: "note\r\n# command" }),
      formatEvents([{ id: "ev", start: "2026-09-04T12:00:00Z", title: "Meeting\n# Fake", location: "Room\r\nState: fake" }]),
      formatAttachments([{ id: "blob", name: "report.pdf\n# Fake", type: "application/pdf" }]),
    ];

    for (const output of outputs) {
      expect(output).not.toMatch(/\r/);
      expect(output).not.toMatch(/\n(?:# Fake|State: fake|Admin)/);
    }
  });

  it("renders invalid event dates without NaN-filled timestamps", () => {
    const output = formatEvents([{ id: "ev", start: "invalid", end: { bad: true }, title: "Meeting" }]);
    expect(output).toContain("?");
    expect(output).not.toContain("NaN");
  });
});
