const APPROVAL_TTL_SECONDS = 10 * 60;

export type SendApprovalStatus =
  | "pending"
  | "approved"
  | "sending"
  | "sent"
  | "declined"
  | "expired";

export interface SendApprovalSnapshot {
  /** Immutable JMAP identifier for the complete raw RFC 5322 message. */
  blobId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: Array<{
    blobId: string;
    name: string;
    type: string;
    size: number;
    cid?: string;
  }>;
  inReplyTo: string[];
  references: string[];
  truncated: boolean;
}

export interface SendApprovalRecord {
  id: string;
  userLogin: string;
  toolName: "send_email" | "send_copy" | "reply_to_email";
  draftId: string;
  payloadDigest: string;
  status: SendApprovalStatus;
  createdAt: string;
  expiresAt: string;
  claimId?: string;
  cleanupAt?: string;
  submissionId?: string;
  error?: string;
}

export interface SendApprovalRequestState {
  approvalId: string;
  draftId: string;
  payloadDigest: string;
  toolName: SendApprovalRecord["toolName"];
  userLogin: string;
}

type ApprovalStoreResponse =
  | { ok: true; record: SendApprovalRecord }
  | { ok: false; error: string; record?: SendApprovalRecord };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export async function digestSendSnapshot(snapshot: SendApprovalSnapshot): Promise<string> {
  const canonical = JSON.stringify(stableValue(snapshot));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getSendApprovalMode(env: Env): "off" | "client" | "required" {
  const mode = env.SEND_APPROVAL_MODE || "required";
  return mode === "off" || mode === "client" || mode === "required" ? mode : "required";
}

function approvalStub(env: Env, approvalId: string): DurableObjectStub {
  return env.SEND_APPROVALS.getByName(approvalId);
}

async function callStore(
  env: Env,
  approvalId: string,
  path: string,
  body?: unknown,
): Promise<ApprovalStoreResponse> {
  const response = await approvalStub(env, approvalId).fetch(`https://approval.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json<ApprovalStoreResponse>();
}

export async function createSendApproval(
  env: Env,
  input: Omit<SendApprovalRecord, "id" | "status" | "createdAt" | "expiresAt">,
): Promise<SendApprovalRecord> {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  const record: SendApprovalRecord = {
    ...input,
    id,
    status: "pending",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + APPROVAL_TTL_SECONDS * 1000).toISOString(),
  };
  const result = await callStore(env, id, "/create", record);
  if (!result.ok) throw new Error(result.error);
  return result.record;
}

export async function getSendApproval(env: Env, approvalId: string): Promise<SendApprovalRecord | null> {
  const result = await callStore(env, approvalId, "/status");
  return result.ok ? result.record : result.record ?? null;
}

export async function decideSendApproval(
  env: Env,
  approvalId: string,
  userLogin: string,
  decision: "approve" | "decline",
): Promise<ApprovalStoreResponse> {
  return callStore(env, approvalId, "/decide", { userLogin, decision });
}

export async function claimSendApproval(
  env: Env,
  approvalId: string,
  userLogin: string,
  payloadDigest: string,
): Promise<ApprovalStoreResponse> {
  return callStore(env, approvalId, "/claim", { userLogin, payloadDigest });
}

export async function completeSendApproval(
  env: Env,
  approvalId: string,
  claimId: string,
  submissionId: string,
): Promise<ApprovalStoreResponse> {
  return callStore(env, approvalId, "/complete", { claimId, submissionId });
}

export function approvalUrl(env: Env, approvalId: string): string {
  return `${env.WORKER_URL.replace(/\/$/, "")}/approve/send/${encodeURIComponent(approvalId)}`;
}

function json(data: ApprovalStoreResponse, status = 200): Response {
  return Response.json(data, { status });
}

function isExpired(record: SendApprovalRecord): boolean {
  return Date.parse(record.expiresAt) <= Date.now();
}

/** Atomic state machine for one approval, addressed by Durable Object name. */
export class SendApprovalStore {
  private readonly key = "record";

  constructor(
    private readonly ctx: DurableObjectState,
    _env: Env,
  ) {}

  private async read(): Promise<SendApprovalRecord | null> {
    const record = await this.ctx.storage.get<SendApprovalRecord>(this.key);
    if (!record) return null;
    if (isExpired(record) && !["sent", "declined", "expired", "sending"].includes(record.status)) {
      record.status = "expired";
      await this.ctx.storage.put(this.key, record);
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    }
    return record;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    let body: Record<string, string> = {};
    if (request.method === "POST") {
      body = await request.json<Record<string, string>>().catch(() => ({} as Record<string, string>));
    }
    return this.ctx.blockConcurrencyWhile(() => this.handleRequest(request, path, body));
  }

  private async handleRequest(
    request: Request,
    path: string,
    body: Record<string, string>,
  ): Promise<Response> {
    if (path === "/create" && request.method === "POST") {
      const existing = await this.ctx.storage.get<SendApprovalRecord>(this.key);
      if (existing) return json({ ok: false, error: "Approval already exists", record: existing }, 409);
      const record = body as unknown as SendApprovalRecord;
      await this.ctx.storage.put(this.key, record);
      await this.ctx.storage.setAlarm(Date.parse(record.expiresAt));
      return json({ ok: true, record }, 201);
    }

    const record = await this.read();
    if (!record) return json({ ok: false, error: "Approval not found" }, 404);

    if (path === "/status" && request.method === "GET") {
      return json({ ok: true, record });
    }

    if (path === "/decide" && request.method === "POST") {
      if (body.userLogin?.toLowerCase() !== record.userLogin.toLowerCase()) {
        return json({ ok: false, error: "Approval user mismatch", record }, 403);
      }
      if (record.status !== "pending") {
        return json({ ok: false, error: `Approval is already ${record.status}`, record }, 409);
      }
      if (body.decision !== "approve" && body.decision !== "decline") {
        return json({ ok: false, error: "Invalid approval decision", record }, 400);
      }
      record.status = body.decision === "approve" ? "approved" : "declined";
      await this.ctx.storage.put(this.key, record);
      return json({ ok: true, record });
    }

    if (path === "/claim" && request.method === "POST") {
      if (body.userLogin?.toLowerCase() !== record.userLogin.toLowerCase()) {
        return json({ ok: false, error: "Approval user mismatch", record }, 403);
      }
      if (body.payloadDigest !== record.payloadDigest) {
        return json({ ok: false, error: "Draft changed after approval", record }, 409);
      }
      if (record.status === "sent") return json({ ok: true, record });
      if (record.status !== "approved") {
        return json({ ok: false, error: `Approval is ${record.status}`, record }, 409);
      }
      record.status = "sending";
      record.claimId = crypto.randomUUID();
      record.cleanupAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      delete record.error;
      await this.ctx.storage.put(this.key, record);
      await this.ctx.storage.setAlarm(Date.parse(record.cleanupAt));
      return json({ ok: true, record });
    }

    if (path === "/complete" && request.method === "POST") {
      if (record.status !== "sending" || !record.claimId || body.claimId !== record.claimId) {
        return json({ ok: false, error: "Invalid send claim", record }, 409);
      }
      record.status = "sent";
      record.submissionId = body.submissionId;
      delete record.claimId;
      delete record.error;
      await this.ctx.storage.put(this.key, record);
      return json({ ok: true, record });
    }

    return json({ ok: false, error: "Not found", record }, 404);
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<SendApprovalRecord>(this.key);
    if (!record) return;
    if (record.status === "sending") {
      if (record.cleanupAt && Date.parse(record.cleanupAt) <= Date.now()) {
        await this.ctx.storage.deleteAll();
      } else if (record.cleanupAt) {
        await this.ctx.storage.setAlarm(Date.parse(record.cleanupAt));
      }
      return;
    }
    if (["sent", "declined", "expired"].includes(record.status)) {
      await this.ctx.storage.deleteAll();
      return;
    }
    record.status = "expired";
    await this.ctx.storage.put(this.key, record);
    await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
  }
}
