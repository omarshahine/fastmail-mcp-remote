import { describe, expect, it, vi } from "vitest";
import { FastmailAuth } from "../src/fastmail-auth";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JmapClient, SENT_MOVE_REFUSED, foldAddress } from "../src/jmap-client";
import { registerAllTools, type ToolContext } from "../src/tools";
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

  it("passes the folded identity emails to the Sent lookup, without empties", async () => {
    const client = fakeClient(["bob@example.com"], ["Me@Example.com", ""]);
    expect(await isInlineReplyEligible(client, snapshot())).toBe(true);
    expect(client.findPreviouslySentRecipients).toHaveBeenCalledWith(
      ["bob@example.com"],
      new Set(["me@example.com"]),
    );
  });

  it("a Kelvin sign (U+212A) recipient does not match an ASCII k identity or contact", async () => {
    const kelvin = "\u212Aate@example.com";
    const asIdentity = fakeClient([], ["me@example.com", "kate@example.com"]);
    expect(await isInlineReplyEligible(asIdentity, snapshot({ to: [kelvin] }))).toBe(false);
    expect(asIdentity.findPreviouslySentRecipients).toHaveBeenCalledWith([kelvin], expect.any(Set));
    const asContact = fakeClient(["kate@example.com"]);
    expect(await isInlineReplyEligible(asContact, snapshot({ to: [kelvin] }))).toBe(false);
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

describe("foldAddress", () => {
  it("lowercases ASCII only and trims", () => {
    expect(foldAddress("  Bob@Example.COM ")).toBe("bob@example.com");
    expect(foldAddress("\u212Aate@example.com")).toBe("\u212Aate@example.com");
    expect(foldAddress("\u00C9lise@example.com")).toBe("\u00C9lise@example.com");
  });
});

describe("JmapClient.findPreviouslySentRecipients", () => {
  const ME = new Set(["me@example.com"]);

  function sentMessage(fields: Record<string, any> = {}) {
    return {
      id: "e1",
      from: [{ email: "Me@example.com" }],
      to: [{ name: "X", email: "bob@example.com" }],
      cc: null,
      bcc: null,
      keywords: { $seen: true },
      ...fields,
    };
  }

  function makeClient(list: any[] = [sentMessage()], getResponse?: [string, any, string]) {
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
        ["Email/query", { ids: list.map((e) => e.id) }, "q0"],
        getResponse ?? ["Email/get", { list }, "g0"],
      ],
      sessionState: "state",
    });
    return { client, makeRequest };
  }

  it("ignores substring matches", async () => {
    const { client } = makeClient([sentMessage({ to: [{ email: "evilbob@example.com" }] })]);
    expect((await client.findPreviouslySentRecipients(["bob@example.com"], ME)).size).toBe(0);
  });

  it("matches exactly, case-insensitively, with one request", async () => {
    const { client, makeRequest } = makeClient([sentMessage({ to: [{ email: "Bob@example.com" }] })]);
    const found = await client.findPreviouslySentRecipients(["bob@example.com"], ME);
    expect([...found]).toEqual(["bob@example.com"]);
    expect(makeRequest).toHaveBeenCalledTimes(1);
    const call = makeRequest.mock.calls[0][0];
    expect(call.methodCalls[0][1].filter.conditions[0]).toEqual({ inMailbox: "sent-1" });
    expect(call.methodCalls[0][1].filter.conditions[1]).toEqual({ notKeyword: "$draft" });
    expect(call.methodCalls[1][1].properties).toEqual(expect.arrayContaining(["from", "keywords", "to", "cc", "bcc"]));
  });

  it("counts cc and bcc matches", async () => {
    const cc = makeClient([sentMessage({ to: [{ email: "other@example.com" }], cc: [{ email: "bob@example.com" }] })]);
    expect([...(await cc.client.findPreviouslySentRecipients(["bob@example.com"], ME))]).toEqual(["bob@example.com"]);
    const bcc = makeClient([sentMessage({ to: [], bcc: [{ email: "bob@example.com" }] })]);
    expect([...(await bcc.client.findPreviouslySentRecipients(["bob@example.com"], ME))]).toEqual(["bob@example.com"]);
  });

  it("does not count a draft moved into Sent", async () => {
    const { client } = makeClient([sentMessage({ keywords: { $draft: true, $seen: true } })]);
    expect((await client.findPreviouslySentRecipients(["bob@example.com"], ME)).size).toBe(0);
  });

  it("does not count an inbound message in Sent (from is not an identity)", async () => {
    const { client } = makeClient([
      sentMessage({ from: [{ email: "attacker@example.com" }], to: [{ email: "me@example.com" }], cc: [{ email: "bob@example.com" }] }),
    ]);
    expect((await client.findPreviouslySentRecipients(["bob@example.com"], ME)).size).toBe(0);
  });

  it("counts nothing without identity emails", async () => {
    const { client, makeRequest } = makeClient();
    expect((await client.findPreviouslySentRecipients(["bob@example.com"], new Set())).size).toBe(0);
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it("a Kelvin sign (U+212A) address does not match ASCII k", async () => {
    const { client } = makeClient([sentMessage({ to: [{ email: "kate@example.com" }] })]);
    expect((await client.findPreviouslySentRecipients(["\u212Aate@example.com"], ME)).size).toBe(0);
  });

  it("throws when Email/get errors, so the reply is not eligible", async () => {
    const { client } = makeClient([sentMessage()], ["error", { type: "serverFail" }, "g0"]);
    await expect(client.findPreviouslySentRecipients(["bob@example.com"], ME)).rejects.toThrow(/lookup failed/);
    vi.spyOn(client, "getIdentities").mockResolvedValue([{ email: "me@example.com" }]);
    expect(await isInlineReplyEligible(client, snapshot())).toBe(false);
  });

  it("returns an empty set without a request for empty input or no Sent mailbox", async () => {
    const { client, makeRequest } = makeClient();
    expect((await client.findPreviouslySentRecipients([], ME)).size).toBe(0);
    expect(makeRequest).not.toHaveBeenCalled();
    vi.spyOn(client, "getMailboxes").mockResolvedValue([{ id: "x", role: null, name: "Sent" }]);
    expect((await client.findPreviouslySentRecipients(["bob@example.com"], ME)).size).toBe(0);
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it("end to end: a real sent reply makes the recipient eligible", async () => {
    const { client } = makeClient();
    vi.spyOn(client, "getIdentities").mockResolvedValue([{ email: "me@example.com" }]);
    expect(await isInlineReplyEligible(client, snapshot())).toBe(true);
  });
});

describe("moves into Sent", () => {
  function makeClient() {
    const client = new JmapClient(new FastmailAuth({ apiToken: "test-token" }));
    vi.spyOn(client, "getSession").mockResolvedValue({
      apiUrl: "https://api.fastmail.com/jmap/api/",
      accountId: "account-1",
      capabilities: {},
    });
    vi.spyOn(client, "getMailboxes").mockResolvedValue([
      { id: "archive-1", role: "archive", name: "Archive" },
      { id: "sent-1", role: "sent", name: "Sent" },
    ]);
    const makeRequest = vi.spyOn(client, "makeRequest").mockResolvedValue({
      methodResponses: [["Email/set", { updated: {} }, "x"]],
      sessionState: "state",
    });
    return { client, makeRequest };
  }

  it("JmapClient.moveEmail and bulkMove refuse Sent without a request", async () => {
    const { client, makeRequest } = makeClient();
    await expect(client.moveEmail("e1", "sent-1")).rejects.toThrow(SENT_MOVE_REFUSED);
    await expect(client.bulkMove(["e1", "e2"], "sent-1")).rejects.toThrow(SENT_MOVE_REFUSED);
    expect(makeRequest).not.toHaveBeenCalled();
  });

  it("JmapClient.moveEmail and bulkMove still move to Archive", async () => {
    const { client, makeRequest } = makeClient();
    await client.moveEmail("e1", "archive-1");
    await client.bulkMove(["e1", "e2"], "archive-1");
    expect(makeRequest).toHaveBeenCalledTimes(2);
    expect(makeRequest.mock.calls[0][0].methodCalls[0][1].update).toEqual({ e1: { mailboxIds: { "archive-1": true } } });
  });

  it("JmapClient.moveEmail fails closed when the mailbox lookup fails", async () => {
    const { client, makeRequest } = makeClient();
    vi.spyOn(client, "getMailboxes").mockRejectedValue(new Error("JMAP unavailable"));
    await expect(client.moveEmail("e1", "archive-1")).rejects.toThrow("JMAP unavailable");
    expect(makeRequest).not.toHaveBeenCalled();
  });

  function tools(client: Record<string, any>) {
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const server = {
      tool(...args: any[]) {
        handlers.set(args[0], args[args.length - 1]);
      },
    } as unknown as McpServer;
    const context: ToolContext = {
      env: { SEND_APPROVAL_MODE: "off" } as unknown as Env,
      getCurrentUser: () => "me@example.com",
      getJmapClient: () => client as any,
      getContactsCalendarClient: vi.fn() as any,
      checkToolPermission: async () => null,
      guardResponse: vi.fn() as any,
    };
    registerAllTools(server, context, new Set(["move_email", "bulk_move"]));
    return handlers;
  }

  function toolClient() {
    return {
      getMailboxes: vi.fn().mockResolvedValue([
        { id: "archive-1", role: "archive", name: "Archive" },
        { id: "sent-1", role: "sent", name: "Sent" },
      ]),
      moveEmail: vi.fn().mockResolvedValue(undefined),
      bulkMove: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("move_email and bulk_move refuse a Sent target", async () => {
    const client = toolClient();
    const handlers = tools(client);
    const single = await handlers.get("move_email")!({ emailId: "e1", targetMailboxId: "sent-1" }, {});
    expect(single).toEqual({ content: [{ type: "text", text: "Emails cannot be moved into Sent." }], isError: true });
    // Refused before any bulk confirmation is requested.
    const bulk = await handlers.get("bulk_move")!({ emailIds: ["e1", "e2"], targetMailboxId: "sent-1" }, {});
    expect(bulk).toEqual({ content: [{ type: "text", text: "Emails cannot be moved into Sent." }], isError: true });
    expect(client.moveEmail).not.toHaveBeenCalled();
    expect(client.bulkMove).not.toHaveBeenCalled();
  });

  it("move_email and bulk_move still move to Archive (the email reader's archive action)", async () => {
    const client = toolClient();
    const handlers = tools(client);
    const single = await handlers.get("move_email")!({ emailId: "e1", targetMailboxId: "archive-1" }, {});
    expect(single.isError).toBeFalsy();
    expect(client.moveEmail).toHaveBeenCalledWith("e1", "archive-1");
    const bulk = await handlers.get("bulk_move")!({ emailIds: ["e1", "e2"], targetMailboxId: "archive-1" }, {});
    expect(bulk.isError).toBeFalsy();
    expect(client.bulkMove).toHaveBeenCalledWith(["e1", "e2"], "archive-1");
  });
});
