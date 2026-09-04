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
  const makeRequest = vi.spyOn(client, "makeRequest").mockResolvedValue({
    methodResponses: [["Email/set", {}, "update"]],
    sessionState: "state",
  });
  return { client, makeRequest };
}

describe("JMAP read-state keyword patches", () => {
  it.each([
    [true, true],
    [false, null],
  ])("patches only $seen for a single email when read=%s", async (read, expected) => {
    const { client, makeRequest } = makeClient();
    await client.markEmailRead("email-1", read);

    const request = makeRequest.mock.calls[0][0] as JmapRequest;
    expect(request.methodCalls[0][1].update).toEqual({
      "email-1": { "keywords/$seen": expected },
    });
    expect(request.methodCalls[0][1].update["email-1"]).not.toHaveProperty("keywords");
  });

  it.each([
    [true, true],
    [false, null],
  ])("patches only $seen for bulk email updates when read=%s", async (read, expected) => {
    const { client, makeRequest } = makeClient();
    await client.bulkMarkRead(["email-1", "email-2"], read);

    const request = makeRequest.mock.calls[0][0] as JmapRequest;
    expect(request.methodCalls[0][1].update).toEqual({
      "email-1": { "keywords/$seen": expected },
      "email-2": { "keywords/$seen": expected },
    });
  });
});
