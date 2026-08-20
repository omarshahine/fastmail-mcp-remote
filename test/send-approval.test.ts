import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JmapClient } from "../src/jmap-client";
import {
  SendApprovalStore,
  digestSendSnapshot,
  type SendApprovalRecord,
  type SendApprovalSnapshot,
} from "../src/send-approval";
import { registerAllTools, type ToolContext } from "../src/tools";

class MemoryStorage {
  private values = new Map<string, unknown>();
  alarm?: number;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
  }
}

class MemoryState {
  readonly storage = new MemoryStorage();
  private queue: Promise<unknown> = Promise.resolve();

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.queue.then(callback);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function snapshot(subject = "Approval test"): SendApprovalSnapshot {
  return {
    blobId: "raw-message-1",
    from: "sender@example.com",
    to: ["recipient@example.com"],
    cc: [],
    bcc: [],
    subject,
    textBody: "This message must not send before approval.",
    htmlBody: "",
    attachments: [],
    inReplyTo: [],
    references: [],
    truncated: false,
  };
}

function record(overrides: Partial<SendApprovalRecord> = {}): SendApprovalRecord {
  return {
    id: "approval-1",
    userLogin: "sender@example.com",
    toolName: "send_email",
    draftId: "draft-1",
    payloadDigest: "digest-1",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

async function json(response: Response): Promise<any> {
  return response.json();
}

describe("SendApprovalStore", () => {
  it("binds approval to a canonical snapshot digest", async () => {
    const first = snapshot();
    const reordered = {
      blobId: first.blobId,
      subject: first.subject,
      bcc: first.bcc,
      from: first.from,
      references: first.references,
      textBody: first.textBody,
      to: first.to,
      attachments: first.attachments,
      inReplyTo: first.inReplyTo,
      htmlBody: first.htmlBody,
      cc: first.cc,
      truncated: first.truncated,
    } as SendApprovalSnapshot;

    expect(await digestSendSnapshot(first)).toBe(await digestSendSnapshot(reordered));
    expect(await digestSendSnapshot({ ...first, subject: "Changed" })).not.toBe(await digestSendSnapshot(first));
    expect(await digestSendSnapshot({ ...first, blobId: "raw-message-2" })).not.toBe(await digestSendSnapshot(first));
  });

  it("rechecks the approved raw message immediately before draft submission", async () => {
    const client = new JmapClient({} as any);
    const approved = snapshot();
    const approvedDigest = await digestSendSnapshot(approved);
    vi.spyOn(client, "getDraftApprovalSnapshot").mockResolvedValue({
      ...approved,
      blobId: "raw-message-edited",
    });
    const request = vi.fn();
    (client as any).getSession = vi.fn().mockResolvedValue({ accountId: "account-1" });
    (client as any).makeRequest = request;

    await expect(client.submitDraft("draft-1", approvedDigest))
      .rejects.toThrow("Draft changed after approval");
    expect(request).not.toHaveBeenCalled();
  });

  it("allows only one concurrent send claim and makes completion idempotent", async () => {
    const store = new SendApprovalStore(new MemoryState() as unknown as DurableObjectState, {} as Env);
    expect((await json(await store.fetch(new Request("https://approval.internal/create", {
      method: "POST",
      body: JSON.stringify(record()),
    })))).ok).toBe(true);
    expect((await json(await store.fetch(new Request("https://approval.internal/decide", {
      method: "POST",
      body: JSON.stringify({ userLogin: "sender@example.com", decision: "approve" }),
    })))).record.status).toBe("approved");

    const claims = await Promise.all([
      store.fetch(new Request("https://approval.internal/claim", {
        method: "POST",
        body: JSON.stringify({ userLogin: "sender@example.com", payloadDigest: "digest-1" }),
      })).then(json),
      store.fetch(new Request("https://approval.internal/claim", {
        method: "POST",
        body: JSON.stringify({ userLogin: "sender@example.com", payloadDigest: "digest-1" }),
      })).then(json),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.ok)).toHaveLength(1);

    const claimed = claims.find((claim) => claim.ok);
    const complete = await json(await store.fetch(new Request("https://approval.internal/complete", {
      method: "POST",
      body: JSON.stringify({ claimId: claimed.record.claimId, submissionId: "submission-1" }),
    })));
    expect(complete.record).toMatchObject({ status: "sent", submissionId: "submission-1" });

    const status = await json(await store.fetch(new Request("https://approval.internal/status")));
    expect(status.record).toMatchObject({ status: "sent", submissionId: "submission-1" });
  });

  it("rejects the wrong user, changed payload, and declined approvals", async () => {
    const store = new SendApprovalStore(new MemoryState() as unknown as DurableObjectState, {} as Env);
    await store.fetch(new Request("https://approval.internal/create", {
      method: "POST",
      body: JSON.stringify(record()),
    }));

    const wrongUser = await json(await store.fetch(new Request("https://approval.internal/decide", {
      method: "POST",
      body: JSON.stringify({ userLogin: "attacker@example.com", decision: "approve" }),
    })));
    expect(wrongUser.ok).toBe(false);

    await store.fetch(new Request("https://approval.internal/decide", {
      method: "POST",
      body: JSON.stringify({ userLogin: "sender@example.com", decision: "decline" }),
    }));
    const claim = await json(await store.fetch(new Request("https://approval.internal/claim", {
      method: "POST",
      body: JSON.stringify({ userLogin: "sender@example.com", payloadDigest: "changed" }),
    })));
    expect(claim.ok).toBe(false);
    expect(claim.record.status).toBe("declined");
  });
});

function approvalNamespace() {
  const stores = new Map<string, SendApprovalStore>();
  return {
    getByName(id: string) {
      let store = stores.get(id);
      if (!store) {
        store = new SendApprovalStore(new MemoryState() as unknown as DurableObjectState, {} as Env);
        stores.set(id, store);
      }
      return { fetch: (request: Request | string, init?: RequestInit) => store!.fetch(new Request(request, init)) };
    },
  };
}

function registeredSendTools(
  client: Record<string, any>,
  modernState?: { value?: any },
) {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const server = {
    tool(...args: any[]) {
      handlers.set(args[0], args[args.length - 1]);
    },
  } as unknown as McpServer;
  const env = {
    SEND_APPROVAL_MODE: "required",
    WORKER_URL: "https://mail.example.test",
    SEND_APPROVALS: approvalNamespace(),
  } as unknown as Env;
  const context: ToolContext = {
    env,
    getCurrentUser: () => "sender@example.com",
    getJmapClient: () => client as any,
    getContactsCalendarClient: vi.fn() as any,
    checkToolPermission: async () => null,
    guardResponse: vi.fn() as any,
    ...(modernState ? {
      modernMcp: {
        getClientCapabilities: () => ({ elicitation: { url: {} } }),
        mintRequestState: async (state: any) => {
          modernState.value = state;
          return "signed-request-state";
        },
      },
    } : {}),
  };
  registerAllTools(server, context, new Set(["send_email", "send_copy", "reply_to_email"]));
  return handlers;
}

describe("outbound tool approval gate", () => {
  it("prepares send_email as a draft without calling direct send", async () => {
    const client = {
      createDraft: vi.fn().mockResolvedValue("draft-new"),
      getDraftApprovalSnapshot: vi.fn().mockResolvedValue(snapshot()),
      sendEmail: vi.fn(),
    };
    const handler = registeredSendTools(client).get("send_email")!;
    const result = await handler({
      to: ["recipient@example.com"], subject: "Approval test", textBody: "Hello",
    }, {});

    expect(client.createDraft).toHaveBeenCalledOnce();
    expect(client.sendEmail).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Nothing will be sent until you approve it");
    expect(result.content[0].text).toContain("https://mail.example.test/approve/send/");
  });

  it("does not persist a multi-megabyte body in the Durable Object record", async () => {
    const largeSnapshot = snapshot();
    largeSnapshot.textBody = "x".repeat(2_500_000);
    const client = {
      createDraft: vi.fn().mockResolvedValue("draft-large"),
      getDraftApprovalSnapshot: vi.fn().mockResolvedValue(largeSnapshot),
      sendEmail: vi.fn(),
    };
    const handler = registeredSendTools(client).get("send_email")!;
    const result = await handler({
      to: ["recipient@example.com"], subject: "Large approval", textBody: largeSnapshot.textBody,
    }, {});

    expect(result.content[0].text).toContain("Review and approve:");
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it("fails closed when JMAP truncates a body used for approval", async () => {
    const truncated = snapshot();
    truncated.truncated = true;
    const client = {
      createDraft: vi.fn().mockResolvedValue("draft-truncated"),
      getDraftApprovalSnapshot: vi.fn().mockResolvedValue(truncated),
      sendEmail: vi.fn(),
    };
    const handler = registeredSendTools(client).get("send_email")!;
    const result = await handler({
      to: ["recipient@example.com"], subject: "Truncated approval", textBody: "Hello",
    }, {});

    expect(result.content[0].text).toContain("too large to review safely");
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it("uses MCP 2026 URL elicitation without creating a second draft on retry", async () => {
    const client = {
      createDraft: vi.fn().mockResolvedValue("draft-modern"),
      getDraftApprovalSnapshot: vi.fn().mockResolvedValue(snapshot()),
      sendEmail: vi.fn(),
    };
    const modernState: { value?: any } = {};
    const handler = registeredSendTools(client, modernState).get("send_email")!;
    const args = { to: ["recipient@example.com"], subject: "Approval test", textBody: "Hello" };
    const first = await handler(args, {
      mcpReq: { requestState: () => undefined, inputResponses: undefined },
    });

    expect(first).toMatchObject({
      resultType: "input_required",
      requestState: "signed-request-state",
      inputRequests: { approval: { method: "elicitation/create" } },
    });
    expect(client.createDraft).toHaveBeenCalledOnce();

    const retry = await handler(args, {
      mcpReq: {
        requestState: () => modernState.value,
        inputResponses: { approval: { action: "accept" } },
      },
    });
    expect(retry.content[0].text).toContain("Nothing will be sent until you approve it");
    expect(client.createDraft).toHaveBeenCalledOnce();
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it("prepares send_copy as a draft without calling direct send", async () => {
    const client = {
      createCopyDraft: vi.fn().mockResolvedValue("draft-copy"),
      getDraftApprovalSnapshot: vi.fn().mockResolvedValue(snapshot("Copied email")),
      sendCopy: vi.fn(),
    };
    const handler = registeredSendTools(client).get("send_copy")!;
    await handler({ emailId: "source-1", to: ["recipient@example.com"] }, {});

    expect(client.createCopyDraft).toHaveBeenCalledOnce();
    expect(client.sendCopy).not.toHaveBeenCalled();
  });

  it("prepares an immediate reply as a draft without calling direct send", async () => {
    const client = {
      getEmailById: vi.fn().mockResolvedValue({
        from: [{ email: "recipient@example.com" }],
        subject: "Question",
        messageId: ["message-1"],
        references: [],
        receivedAt: new Date().toISOString(),
        textBody: [],
        htmlBody: [],
        bodyValues: {},
      }),
      createDraft: vi.fn().mockResolvedValue("draft-reply"),
      getDraftApprovalSnapshot: vi.fn().mockResolvedValue(snapshot("Re: Question")),
      sendEmail: vi.fn(),
    };
    const handler = registeredSendTools(client).get("reply_to_email")!;
    await handler({
      emailId: "source-1",
      body: "Answer",
      replyAll: false,
      sendImmediately: true,
      excludeQuote: false,
    }, {});

    expect(client.createDraft).toHaveBeenCalledOnce();
    expect(client.sendEmail).not.toHaveBeenCalled();
  });
});
