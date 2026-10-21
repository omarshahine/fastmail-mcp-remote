import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BULK_CONFIRM_THRESHOLD,
  digestEmailIds,
  supportsFormElicitation,
  type BulkConfirmRequestState,
} from "../src/bulk-confirm";
import { createMcpRequestStateCodec } from "../src/mcp-server";
import { registerAllTools, type ToolContext } from "../src/tools";

const USER = "sender@example.com";
const TEST_KEY = "test-signing-key-that-is-at-least-32-bytes-long";

function ids(count: number, prefix = "M"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** Registered-tool harness backed by a real HMAC request-state codec. */
function harness(options: { caps?: any; client?: Record<string, any>; env?: Record<string, unknown> } = {}) {
  const env = { ACTION_SIGNING_KEY: TEST_KEY, SEND_APPROVAL_MODE: "off", ...options.env } as unknown as Env;
  const codec = createMcpRequestStateCodec(env, USER);
  const client = options.client ?? {
    bulkDelete: vi.fn().mockResolvedValue(undefined),
    bulkMove: vi.fn().mockResolvedValue(undefined),
    getMailboxes: vi.fn().mockResolvedValue([{ id: "mb-archive", name: "Archive 2026" }]),
    sendEmail: vi.fn().mockResolvedValue("submission-1"),
  };
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const server = {
    tool(...args: any[]) {
      handlers.set(args[0], args[args.length - 1]);
    },
  } as unknown as McpServer;
  const context: ToolContext = {
    env,
    getCurrentUser: () => USER,
    getJmapClient: () => client as any,
    getContactsCalendarClient: vi.fn() as any,
    checkToolPermission: async () => null,
    guardResponse: vi.fn() as any,
    modernMcp: {
      getClientCapabilities: () => options.caps ?? { elicitation: { form: {} } },
      mintRequestState: (state, ctx) => codec.mint(state, ctx),
    },
  };
  registerAllTools(server, context, new Set(["bulk_delete", "bulk_move", "send_email"]));

  /** Build the `extra` a tool handler sees, verifying `token` like the server does. */
  async function extra(token?: string, inputResponses?: Record<string, unknown>) {
    const ctx = { mcpReq: { method: "tools/call" } } as any;
    const state = token ? await codec.verify(token, ctx) : undefined;
    return { mcpReq: { method: "tools/call", requestState: () => state, inputResponses } };
  }

  async function mint(state: any) {
    return codec.mint(state, { mcpReq: { method: "tools/call" } } as any);
  }

  return { handlers, client, extra, mint };
}

describe("bulk confirmation helpers", () => {
  it("uses a threshold of 25", () => {
    expect(BULK_CONFIRM_THRESHOLD).toBe(25);
  });

  it("digests ids independent of order and duplicates", async () => {
    expect(await digestEmailIds(["b", "a", "a"])).toBe(await digestEmailIds(["a", "b"]));
    expect(await digestEmailIds(["a", "b"])).not.toBe(await digestEmailIds(["a", "c"]));
    expect(await digestEmailIds(["a"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects form elicitation support", () => {
    expect(supportsFormElicitation({ elicitation: { form: {} } })).toBe(true);
    expect(supportsFormElicitation({ elicitation: {} })).toBe(true);
    expect(supportsFormElicitation({ elicitation: { url: {} } })).toBe(false);
    expect(supportsFormElicitation({})).toBe(false);
    expect(supportsFormElicitation(undefined)).toBe(false);
  });
});

describe("bulk operation form-elicitation gate", () => {
  it("below threshold proceeds without asking", async () => {
    const h = harness();
    const emailIds = ids(24);
    const result = await h.handlers.get("bulk_delete")!({ emailIds }, await h.extra());
    expect(h.client.bulkDelete).toHaveBeenCalledOnce();
    expect(h.client.bulkDelete).toHaveBeenCalledWith(emailIds);
    expect(result.resultType).toBeUndefined();
  });

  it("client without form support proceeds", async () => {
    const h = harness({ caps: { elicitation: { url: {} } } });
    await h.handlers.get("bulk_delete")!({ emailIds: ids(25) }, await h.extra());
    expect(h.client.bulkDelete).toHaveBeenCalledOnce();
  });

  it("form client gets input_required", async () => {
    const h = harness();
    const result = await h.handlers.get("bulk_delete")!({ emailIds: ids(25) }, await h.extra());
    expect(result.resultType).toBe("input_required");
    expect(typeof result.requestState).toBe("string");
    const confirm = result.inputRequests.confirm;
    expect(confirm.method).toBe("elicitation/create");
    expect(confirm.params.mode).toBe("form");
    expect(confirm.params.message).toBe("Move 25 emails to Trash?");
    expect(confirm.params.requestedSchema.properties.confirm.type).toBe("boolean");
    expect(confirm.params.requestedSchema.properties.confirm.default).toBe(false);
    expect(confirm.params.requestedSchema.required).toEqual(["confirm"]);
    expect(h.client.bulkDelete).not.toHaveBeenCalled();
  });

  it("accept with confirm true executes the same ids", async () => {
    const h = harness();
    const emailIds = ids(30);
    const handler = h.handlers.get("bulk_delete")!;
    const first = await handler({ emailIds }, await h.extra());
    const second = await handler(
      { emailIds },
      await h.extra(first.requestState, { confirm: { action: "accept", content: { confirm: true } } }),
    );
    expect(h.client.bulkDelete).toHaveBeenCalledOnce();
    expect(h.client.bulkDelete).toHaveBeenCalledWith(emailIds);
    expect(second.content[0].text).toContain("30 emails deleted");
  });

  it.each([
    ["confirm false", { action: "accept", content: { confirm: false } }],
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
  ])("%s cancels", async (_label, response) => {
    const h = harness();
    const emailIds = ids(25);
    const handler = h.handlers.get("bulk_delete")!;
    const first = await handler({ emailIds }, await h.extra());
    const second = await handler({ emailIds }, await h.extra(first.requestState, { confirm: response }));
    expect(h.client.bulkDelete).not.toHaveBeenCalled();
    expect(second.isError).toBeFalsy();
    expect(second.content[0].text).toBe("Cancelled: no emails were deleted.");
  });

  it("changed ids between rounds is rejected", async () => {
    const h = harness();
    const handler = h.handlers.get("bulk_delete")!;
    const first = await handler({ emailIds: ids(25) }, await h.extra());
    const second = await handler(
      { emailIds: ids(25, "X") },
      await h.extra(first.requestState, { confirm: { action: "accept", content: { confirm: true } } }),
    );
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toBe("Bulk confirmation state does not match this request.");
    expect(h.client.bulkDelete).not.toHaveBeenCalled();
  });

  it("bulk state for another tool is rejected", async () => {
    const h = harness();
    const emailIds = ids(25);
    const first = await h.handlers.get("bulk_delete")!({ emailIds }, await h.extra());
    const second = await h.handlers.get("bulk_move")!(
      { emailIds, targetMailboxId: "mb-archive" },
      await h.extra(first.requestState, { confirm: { action: "accept", content: { confirm: true } } }),
    );
    expect(second.isError).toBe(true);
    expect(h.client.bulkMove).not.toHaveBeenCalled();
  });

  it("bulk state minted for another user is rejected", async () => {
    const h = harness();
    const emailIds = ids(25);
    const state: BulkConfirmRequestState = {
      kind: "bulk_confirm",
      toolName: "bulk_delete",
      idsDigest: await digestEmailIds(emailIds),
      userLogin: "other@example.com",
    };
    const token = await h.mint(state);
    const result = await h.handlers.get("bulk_delete")!(
      { emailIds },
      await h.extra(token, { confirm: { action: "accept", content: { confirm: true } } }),
    );
    expect(result.isError).toBe(true);
    expect(h.client.bulkDelete).not.toHaveBeenCalled();
  });

  it("bulk_move names the target mailbox", async () => {
    const h = harness();
    const emailIds = ids(26);
    const handler = h.handlers.get("bulk_move")!;
    const first = await handler({ emailIds, targetMailboxId: "mb-archive" }, await h.extra());
    expect(first.resultType).toBe("input_required");
    expect(first.inputRequests.confirm.params.message).toBe('Move 26 emails to "Archive 2026"?');
    expect(h.client.bulkMove).not.toHaveBeenCalled();

    const declined = await handler(
      { emailIds, targetMailboxId: "mb-archive" },
      await h.extra(first.requestState, { confirm: { action: "decline" } }),
    );
    expect(declined.content[0].text).toBe("Cancelled: no emails were moved.");

    const accepted = await handler(
      { emailIds, targetMailboxId: "mb-archive" },
      await h.extra(first.requestState, { confirm: { action: "accept", content: { confirm: true } } }),
    );
    expect(h.client.bulkMove).toHaveBeenCalledWith(emailIds, "mb-archive");
    expect(accepted.content[0].text).toContain("26 emails moved");
  });

  it("bulk_move rejects a changed target mailbox", async () => {
    const h = harness();
    const emailIds = ids(25);
    const handler = h.handlers.get("bulk_move")!;
    const first = await handler({ emailIds, targetMailboxId: "mb-archive" }, await h.extra());
    const second = await handler(
      { emailIds, targetMailboxId: "mb-other" },
      await h.extra(first.requestState, { confirm: { action: "accept", content: { confirm: true } } }),
    );
    expect(second.isError).toBe(true);
    expect(h.client.bulkMove).not.toHaveBeenCalled();
  });

  it("bulk_move falls back to the mailbox id when the name is unknown", async () => {
    const h = harness();
    const first = await h.handlers.get("bulk_move")!(
      { emailIds: ids(25), targetMailboxId: "mb-missing" },
      await h.extra(),
    );
    expect(first.inputRequests.confirm.params.message).toBe('Move 25 emails to "mb-missing"?');
  });

  it("send approval resume ignores bulk state", async () => {
    const h = harness();
    const state: BulkConfirmRequestState = {
      kind: "bulk_confirm",
      toolName: "bulk_delete",
      idsDigest: await digestEmailIds(ids(25)),
      userLogin: USER,
    };
    const token = await h.mint(state);
    const result = await h.handlers.get("send_email")!(
      { to: ["recipient@example.com"], subject: "Hi", textBody: "Hello" },
      await h.extra(token),
    );
    expect(result.content[0].text).not.toContain("Approval state does not match");
    expect(h.client.sendEmail).toHaveBeenCalledOnce();
  });
});
