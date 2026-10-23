import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JmapClient } from "../src/jmap-client";
import { _resetCache } from "../src/permissions";
import { createSendApproval, decideSendApproval, digestSendSnapshot, getSendApproval, type SendApprovalSnapshot } from "../src/send-approval";
import { handleSendApprovalDecision } from "../src/send-approval-auth";
import { approvalNamespace } from "./helpers/approval-store";

const USER = "sender@example.com";

const snapshot: SendApprovalSnapshot = {
  blobId: "raw-message-1",
  from: USER,
  to: ["recipient@example.com"],
  cc: [],
  bcc: [],
  subject: "Page test",
  textBody: "Body.",
  htmlBody: "",
  attachments: [],
  inReplyTo: [],
  references: [],
  truncated: false,
};

async function setup() {
  const config = { users: { [USER]: { role: "admin", disabled_categories: [] } }, default_role: "delegate", default_disabled_categories: [] };
  const forms = new Map<string, string>();
  const env = {
    SEND_APPROVALS: approvalNamespace(),
    FASTMAIL_API_TOKEN: "test-token",
    OAUTH_KV: {
      get: vi.fn(async (key: string) => (key === "config:permissions" ? config : forms.get(key) ?? null)),
      put: vi.fn(async (key: string, value: string) => { forms.set(key, value); }),
      delete: vi.fn(async (key: string) => { forms.delete(key); }),
    },
  } as unknown as Env;
  const record = await createSendApproval(env, {
    userLogin: USER,
    toolName: "send_email",
    draftId: "draft-1",
    payloadDigest: await digestSendSnapshot(snapshot),
  });
  let n = 0;
  const approve = async (decision = "approve") => {
    const token = `form-${++n}`;
    forms.set(`send-approval-form:${token}`, JSON.stringify({ approvalId: record.id, userLogin: USER }));
    const body = new URLSearchParams({ token, decision });
    const request = new Request("https://worker.example.test/approve/send/" + record.id, { method: "POST", body });
    const response = await handleSendApprovalDecision(env, request, record.id);
    return { response, html: await response.text() };
  };
  return { env, record, approve };
}

describe("approval page outcomes", () => {
  beforeEach(() => _resetCache());
  afterEach(() => vi.restoreAllMocks());

  it("a failure before the claim says nothing was sent and the retry sends once", async () => {
    const { env, record, approve } = await setup();
    const lookup = vi.spyOn(JmapClient.prototype, "getDraftApprovalSnapshot").mockRejectedValueOnce(new Error("Fastmail is unreachable"));
    vi.spyOn(JmapClient.prototype, "submitDraft").mockResolvedValue("submission-1");

    const failed = await approve();
    expect(failed.response.status).toBe(502);
    expect(failed.html).toContain("Email not sent");
    expect(failed.html).toContain("Fastmail is unreachable");
    expect(failed.html).toContain("Nothing was sent");
    expect(failed.html).toContain(`href="/approve/send/${record.id}"`);
    expect(failed.html).not.toContain("cannot be retried");
    expect((await getSendApproval(env, record.id))?.status).toBe("pending");

    // The review link issues a fresh form; approving again goes through.
    lookup.mockResolvedValue(snapshot);
    const retried = await approve();
    expect(retried.response.status).toBe(200);
    expect(retried.html).toContain("Email sent");
    expect((await getSendApproval(env, record.id))?.status).toBe("sent");
  });

  it("an approved record can be retried: re-running execution skips the second decide", async () => {
    const { env, record, approve } = await setup();
    vi.spyOn(JmapClient.prototype, "getDraftApprovalSnapshot").mockResolvedValue(snapshot);
    // An earlier attempt decided "approve" but failed before the claim.
    const submit = vi.spyOn(JmapClient.prototype, "submitDraft").mockResolvedValue("submission-1");
    await decideSendApproval(env, record.id, USER, "approve");
    expect((await getSendApproval(env, record.id))?.status).toBe("approved");

    const retried = await approve();
    expect(retried.html).toContain("Email sent");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("an uncertain send still tells the user to check Sent and cannot be retried", async () => {
    const { env, record, approve } = await setup();
    vi.spyOn(JmapClient.prototype, "getDraftApprovalSnapshot").mockResolvedValue(snapshot);
    vi.spyOn(JmapClient.prototype, "submitDraft").mockRejectedValue(new Error("network lost"));
    const { response, html } = await approve();
    expect(response.status).toBe(502);
    expect(html).toContain("Send status needs checking");
    expect(html).toContain("cannot be retried");
    expect(html).toContain("Check Fastmail Sent");
    expect(html).not.toContain("safe to try again");
    expect((await getSendApproval(env, record.id))?.status).toBe("sending");
  });
});
