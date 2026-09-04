import { describe, expect, it, vi } from "vitest";
import { ContactsCalendarClient } from "../src/contacts-calendar";
import { FastmailAuth } from "../src/fastmail-auth";

function makeClient() {
  const client = new ContactsCalendarClient(new FastmailAuth({ apiToken: "test-token" }));
  vi.spyOn(client, "getSession").mockResolvedValue({
    apiUrl: "https://api.fastmail.com/jmap/api/",
    accountId: "account-1",
    capabilities: { "urn:ietf:params:jmap:contacts": {} },
  });
  return client;
}

describe("ContactsCalendarClient.getContacts", () => {
  it("returns only Contact/get results", async () => {
    const client = makeClient();
    vi.spyOn(client, "makeRequest").mockResolvedValue({
      methodResponses: [
        ["Contact/query", { ids: ["contact-1"] }, "query"],
        ["Contact/get", { list: [{ id: "contact-1", name: "Alice" }] }, "contacts"],
      ],
      sessionState: "state",
    });

    await expect(client.getContacts()).resolves.toEqual([{ id: "contact-1", name: "Alice" }]);
  });

  it("surfaces contact query failures without returning address books", async () => {
    const client = makeClient();
    const makeRequest = vi.spyOn(client, "makeRequest").mockRejectedValue(new Error("serverFail"));

    await expect(client.getContacts()).rejects.toThrow("serverFail");
    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(makeRequest.mock.calls[0][0].methodCalls.map(([name]) => name)).toEqual([
      "Contact/query",
      "Contact/get",
    ]);
  });
});
