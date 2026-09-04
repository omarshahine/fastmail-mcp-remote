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
});
