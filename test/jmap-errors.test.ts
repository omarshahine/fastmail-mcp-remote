import { afterEach, describe, expect, it, vi } from "vitest";
import { FastmailAuth } from "../src/fastmail-auth";
import { JmapClient } from "../src/jmap-client";

function makeClient() {
  const client = new JmapClient(new FastmailAuth({ apiToken: "test-token" }));
  vi.spyOn(client, "getSession").mockResolvedValue({
    apiUrl: "https://api.fastmail.com/jmap/api/",
    accountId: "account-1",
    capabilities: {},
  });
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JMAP method response validation", () => {
  it("surfaces method-level errors returned with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      methodResponses: [[
        "error",
        { type: "accountNotFound", description: "Mailbox account is unavailable" },
        "mailboxes",
      ]],
      sessionState: "state",
    }), { status: 200 })));

    await expect(makeClient().getMailboxes()).rejects.toThrow(
      "JMAP Mailbox/get failed (accountNotFound): Mailbox account is unavailable",
    );
  });

  it("rejects a missing method response instead of returning malformed data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      methodResponses: [],
      sessionState: "state",
    }), { status: 200 })));

    await expect(makeClient().getMailboxes()).rejects.toThrow(
      'JMAP response is missing result for call "mailboxes"',
    );
  });

  it("surfaces the originating Set failure before a dependent reference error", async () => {
    const client = makeClient();
    vi.spyOn(client, "getIdentities").mockResolvedValue([
      { id: "identity-1", email: "sender@example.com", mayDelete: false },
    ]);
    vi.spyOn(client, "getMailboxes").mockResolvedValue([
      { id: "drafts", name: "Drafts", role: "drafts" },
      { id: "sent", name: "Sent", role: "sent" },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      methodResponses: [
        ["Email/set", {
          notCreated: {
            draft: { type: "invalidProperties", description: "Original failure" },
          },
        }, "createEmail"],
        ["error", { type: "invalidResultReference", description: "Dependent failure" }, "submitEmail"],
      ],
      sessionState: "state",
    }), { status: 200 })));

    await expect(client.sendEmail({
      to: ["recipient@example.com"],
      subject: "Subject",
      textBody: "Body",
    })).rejects.toThrow("Failed to create email: invalidProperties. Original failure");
  });
});
