import { describe, expect, it, vi } from "vitest";
import { FastmailAuth } from "../src/fastmail-auth";
import { JmapClient } from "../src/jmap-client";
import {
  INLINE_RECIPIENT_LIMIT,
  inlineReplyApprovalEnabled,
  isInlineReplyEligible,
} from "../src/inline-approval";
import type { SendApprovalSnapshot } from "../src/send-approval";

function snapshot(overrides: Partial<SendApprovalSnapshot> = {}): SendApprovalSnapshot {
  return {
    blobId: "blob-1",
    from: "me@example.com",
    to: ["bob@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: hello",
    textBody: "thanks",
    htmlBody: "",
    attachments: [],
    ...overrides,
  } as SendApprovalSnapshot;
}

function fakeClient(sent: string[] = [], identities: string[] = ["me@example.com"]) {
  return {
    getIdentities: vi.fn().mockResolvedValue(identities.map((email) => ({ email }))),
    findPreviouslySentRecipients: vi.fn().mockResolvedValue(new Set(sent)),
  };
}

describe("isInlineReplyEligible", () => {
  it("eligible when every recipient was emailed before", async () => {
    expect(await isInlineReplyEligible(fakeClient(["bob@example.com"]), snapshot())).toBe(true);
  });

  it("eligible when the recipient is one of the user's identities", async () => {
    const client = fakeClient([], ["me@example.com", "alias@example.com"]);
    expect(await isInlineReplyEligible(client, snapshot({ to: ["Alias@example.com"] }))).toBe(true);
  });

  it("case-insensitive match", async () => {
    expect(
      await isInlineReplyEligible(fakeClient(["bob@example.com"]), snapshot({ to: ["Bob@Example.COM"] })),
    ).toBe(true);
  });

  it("not eligible when one CC recipient is unknown", async () => {
    const client = fakeClient(["bob@example.com"]);
    expect(await isInlineReplyEligible(client, snapshot({ cc: ["stranger@example.com"] }))).toBe(false);
  });

  it("not eligible with any BCC", async () => {
    const client = fakeClient(["bob@example.com"]);
    expect(await isInlineReplyEligible(client, snapshot({ bcc: ["bob@example.com"] }))).toBe(false);
  });

  it("not eligible with an attachment", async () => {
    const client = fakeClient(["bob@example.com"]);
    const attachments = [{ blobId: "b", name: "a.txt", type: "text/plain", size: 1 }];
    expect(await isInlineReplyEligible(client, snapshot({ attachments }))).toBe(false);
  });

  it("not eligible with no recipients", async () => {
    expect(await isInlineReplyEligible(fakeClient(), snapshot({ to: [], cc: [] }))).toBe(false);
  });

  it("not eligible with 11 recipients", async () => {
    const to = Array.from({ length: INLINE_RECIPIENT_LIMIT + 1 }, (_, i) => `p${i}@example.com`);
    expect(await isInlineReplyEligible(fakeClient(to), snapshot({ to }))).toBe(false);
  });

  it("fails closed when the lookup throws", async () => {
    const client = fakeClient();
    client.findPreviouslySentRecipients.mockRejectedValue(new Error("boom"));
    expect(await isInlineReplyEligible(client, snapshot())).toBe(false);
  });
});

describe("inlineReplyApprovalEnabled", () => {
  it("is false only when set to off", () => {
    expect(inlineReplyApprovalEnabled({} as Env)).toBe(true);
    expect(inlineReplyApprovalEnabled({ INLINE_REPLY_APPROVAL: "on" } as Env)).toBe(true);
    expect(inlineReplyApprovalEnabled({ INLINE_REPLY_APPROVAL: "off" } as Env)).toBe(false);
  });
});

describe("JmapClient.findPreviouslySentRecipients", () => {
  function makeClient(recipient: string) {
    const client = new JmapClient(new FastmailAuth({ apiToken: "test-token" }));
    vi.spyOn(client, "getSession").mockResolvedValue({
      apiUrl: "https://api.fastmail.com/jmap/api/",
      accountId: "account-1",
      capabilities: {},
    });
    vi.spyOn(client, "getMailboxes").mockResolvedValue([
      { id: "inbox-1", role: "inbox", name: "Inbox" },
      { id: "sent-1", role: "sent", name: "Sent" },
    ]);
    const makeRequest = vi.spyOn(client, "makeRequest").mockResolvedValue({
      methodResponses: [
        ["Email/query", { ids: ["e1"] }, "q0"],
        ["Email/get", { list: [{ id: "e1", to: [{ name: "X", email: recipient }], cc: null, bcc: null }] }, "g0"],
      ],
      sessionState: "state",
    });
    return { client, makeRequest };
  }

  it("ignores substring matches", async () => {
    const { client } = makeClient("evilbob@example.com");
    expect((await client.findPreviouslySentRecipients(["bob@example.com"])).size).toBe(0);
  });

  it("matches exactly, case-insensitively, with one request", async () => {
    const { client, makeRequest } = makeClient("Bob@example.com");
    const found = await client.findPreviouslySentRecipients(["bob@example.com"]);
    expect([...found]).toEqual(["bob@example.com"]);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    const call = makeRequest.mock.calls[0][0];
    expect(call.methodCalls[0][1].filter.conditions[0]).toEqual({ inMailbox: "sent-1" });
  });

  it("returns an empty set without a request for empty input or no Sent mailbox", async () => {
    const { client, makeRequest } = makeClient("bob@example.com");
    expect((await client.findPreviouslySentRecipients([])).size).toBe(0);
    expect(makeRequest).not.toHaveBeenCalled();
    vi.spyOn(client, "getMailboxes").mockResolvedValue([{ id: "x", role: null, name: "Sent" }]);
    expect((await client.findPreviouslySentRecipients(["bob@example.com"])).size).toBe(0);
    expect(makeRequest).not.toHaveBeenCalled();
  });
});
