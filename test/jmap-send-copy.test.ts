import { describe, expect, it, vi } from "vitest";
import { FastmailAuth } from "../src/fastmail-auth";
import { JmapClient, type JmapRequest } from "../src/jmap-client";

function makeClient() {
  const client = new JmapClient(new FastmailAuth({ apiToken: "test-token" }));
  vi.spyOn(client, "getSession").mockResolvedValue({
    apiUrl: "https://api.fastmail.com/jmap/api/",
    accountId: "account-1",
    capabilities: {},
  });
  vi.spyOn(client, "getIdentities").mockResolvedValue([
    { id: "identity-1", email: "sender@example.com", mayDelete: false },
  ]);
  return client;
}

describe("JmapClient sendCopy body handling", () => {
  it("rejects a truncated source before creating or submitting a draft", async () => {
    const client = makeClient();
    const makeRequest = vi.spyOn(client, "makeRequest").mockResolvedValue({
      methodResponses: [["Email/get", {
        list: [{
          subject: "Large message",
          bodyValues: { text: { value: "partial", isTruncated: true } },
          textBody: [{ partId: "text", type: "text/plain" }],
        }],
      }, "getSource"]],
      sessionState: "state",
    });
    const getMailboxes = vi.spyOn(client, "getMailboxes");
    const submitDraft = vi.spyOn(client, "submitDraft");

    await expect(client.sendCopy({ emailId: "email-1", to: ["recipient@example.com"] }))
      .rejects.toThrow("too large to copy safely; no draft was created");
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(getMailboxes).not.toHaveBeenCalled();
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it("requests bounded body values and preserves complete values in the clone", async () => {
    const client = makeClient();
    vi.spyOn(client, "getMailboxes").mockResolvedValue([{ id: "drafts", role: "drafts", name: "Drafts" }]);
    const makeRequest = vi.spyOn(client, "makeRequest")
      .mockResolvedValueOnce({
        methodResponses: [["Email/get", {
          list: [{
            subject: "Complete message",
            bodyValues: { text: { value: "complete body", isTruncated: false } },
            textBody: [{ partId: "text", type: "text/plain" }],
            htmlBody: [],
            attachments: [],
          }],
        }, "getSource"]],
        sessionState: "state-1",
      })
      .mockResolvedValueOnce({
        methodResponses: [["Email/set", { created: { clone: { id: "draft-1" } } }, "createClone"]],
        sessionState: "state-2",
      });

    await expect(client.createCopyDraft({ emailId: "email-1", to: ["recipient@example.com"] }))
      .resolves.toBe("draft-1");

    const sourceRequest = makeRequest.mock.calls[0][0] as JmapRequest;
    expect(sourceRequest.methodCalls[0][1].maxBodyValueBytes).toBe(10 * 1024 * 1024);
    const createRequest = makeRequest.mock.calls[1][0] as JmapRequest;
    expect(createRequest.methodCalls[0][1].create.clone.bodyValues).toEqual({
      text: { value: "complete body", isTruncated: false },
    });
  });
});
