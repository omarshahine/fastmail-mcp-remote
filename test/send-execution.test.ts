import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetCache } from "../src/permissions";
import {
  createSendApproval,
  decideSendApproval,
  digestSendSnapshot,
  getSendApproval,
  type SendApprovalSnapshot,
} from "../src/send-approval";
import { executeApprovedSend } from "../src/send-execution";
import { approvalNamespace } from "./helpers/approval-store";

const USER = "sender@example.com";

function snapshot(subject = "Execution test"): SendApprovalSnapshot {
  return {
    blobId: "raw-message-1",
    from: USER,
    to: ["recipient@example.com"],
    cc: [],
    bcc: [],
    subject,
    textBody: "Body.",
    htmlBody: "",
    attachments: [],
    inReplyTo: [],
    references: [],
    truncated: false,
  };
}

function makeEnv(role: "admin" | "delegate" = "admin") {
  const config = { users: { [USER]: { role, disabled_categories: [] } }, default_role: "delegate", default_disabled_categories: [] };
  return {
    SEND_APPROVALS: approvalNamespace(),
    OAUTH_KV: { get: vi.fn(async () => config) },
  } as unknown as Env;
}

async function setup(role: "admin" | "delegate" = "admin") {
  const env = makeEnv(role);
  const approved = snapshot();
  const payloadDigest = await digestSendSnapshot(approved);
  const record = await createSendApproval(env, {
    userLogin: USER,
    toolName: "send_email",
    draftId: "draft-1",
    payloadDigest,
  });
  const client = {
    getDraftApprovalSnapshot: vi.fn(async () => approved),
    submitDraft: vi.fn(async () => "submission-1"),
  };
  return { env, record, client, payloadDigest };
}

describe("executeApprovedSend", () => {
  beforeEach(() => _resetCache());

  it('sends a pending approval once and returns kind "sent" with status "sent"', async () => {
    const { env, record, client, payloadDigest } = await setup();
    const outcome = await executeApprovedSend(env, client as any, record, USER);
    expect(outcome.kind).toBe("sent");
    if (outcome.kind === "sent") {
      expect(outcome.record.status).toBe("sent");
      expect(outcome.record.submissionId).toBe("submission-1");
    }
    expect(client.submitDraft).toHaveBeenCalledTimes(1);
    expect(client.submitDraft).toHaveBeenCalledWith("draft-1", payloadDigest);
  });

  it("returns refused/changed and declines the record when the draft digest changed", async () => {
    const { env, record, client } = await setup();
    client.getDraftApprovalSnapshot.mockResolvedValue(snapshot("Edited after approval"));
    const outcome = await executeApprovedSend(env, client as any, record, USER);
    expect(outcome).toMatchObject({ kind: "refused", reason: "changed" });
    expect(client.submitDraft).not.toHaveBeenCalled();
    expect((await getSendApproval(env, record.id))?.status).toBe("declined");
  });

  it("returns refused/permission when send permission was revoked", async () => {
    const { env, record, client } = await setup("delegate");
    const outcome = await executeApprovedSend(env, client as any, record, USER);
    expect(outcome).toMatchObject({ kind: "refused", reason: "permission" });
    expect(client.submitDraft).not.toHaveBeenCalled();
    expect((await getSendApproval(env, record.id))?.status).toBe("declined");
  });

  it("returns conflict for an already declined approval", async () => {
    const { env, record, client } = await setup();
    await decideSendApproval(env, record.id, USER, "decline");
    const outcome = await executeApprovedSend(env, client as any, record, USER);
    expect(outcome.kind).toBe("conflict");
    expect(client.submitDraft).not.toHaveBeenCalled();
  });

  it('returns kind "error" with the pending record when the draft lookup throws before the claim', async () => {
    const { env, record, client } = await setup();
    client.getDraftApprovalSnapshot.mockRejectedValue(new Error("Draft not found"));
    const outcome = await executeApprovedSend(env, client as any, record, USER);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toBe("Draft not found");
      expect(outcome.record?.status).toBe("pending");
    }
    expect((await getSendApproval(env, record.id))?.status).toBe("pending");
    expect(client.submitDraft).not.toHaveBeenCalled();
  });

  it("returns uncertain and leaves the record sending when submitDraft throws", async () => {
    const { env, record, client } = await setup();
    client.submitDraft.mockRejectedValue(new Error("network lost"));
    const outcome = await executeApprovedSend(env, client as any, record, USER);
    expect(outcome).toEqual({ kind: "uncertain", message: "network lost" });
    expect((await getSendApproval(env, record.id))?.status).toBe("sending");
  });
});
