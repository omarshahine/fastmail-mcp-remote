import type { JmapClient } from "./jmap-client";
import { getPermissionsConfig, getUserConfig, isToolAllowed } from "./permissions";
import {
  claimSendApproval,
  completeSendApproval,
  decideSendApproval,
  digestSendSnapshot,
  type SendApprovalRecord,
} from "./send-approval";

/**
 * - `sent`: the approval is terminal `sent` (record carries the submission id).
 * - `refused`: the approval was declined in the store (permission revoked or draft changed).
 * - `conflict`: the store refused the decide or claim (already decided, expired, ...).
 *   `stage` says which decision was being made; `record` is the store's current record.
 * - `uncertain`: submission may have reached Fastmail; the approval stays `sending`.
 */
export type SendExecutionOutcome =
  | { kind: "sent"; record: SendApprovalRecord }
  | { kind: "refused"; reason: "permission" | "changed"; message: string; record?: SendApprovalRecord }
  | { kind: "conflict"; message: string; record?: SendApprovalRecord; stage?: "decline" | "approve" }
  | { kind: "uncertain"; message: string };

/**
 * Re-check permission and draft digest, then decide, claim, submit and complete
 * a pending send approval. Shared by the Access-authenticated approval page and
 * the in-app approval tool so both run exactly the same guarded path.
 */
export async function executeApprovedSend(
  env: Env,
  client: JmapClient,
  record: SendApprovalRecord,
  userLogin: string,
): Promise<SendExecutionOutcome> {
  const approvalId = record.id;

  async function decline(reason: "permission" | "changed", message: string): Promise<SendExecutionOutcome> {
    const declined = await decideSendApproval(env, approvalId, userLogin, "decline");
    if (!declined.ok) return { kind: "conflict", message: declined.error, record: declined.record, stage: "decline" };
    return { kind: "refused", reason, message, record: declined.record };
  }

  try {
    const permissions = await getPermissionsConfig(env.OAUTH_KV);
    const userConfig = getUserConfig(permissions, userLogin);
    const allowed = isToolAllowed(
      userConfig,
      record.toolName,
      record.toolName === "reply_to_email" || record.toolName === "forward_email" ? { sendImmediately: true } : undefined,
    );
    if (!allowed.allowed) {
      return await decline("permission", allowed.error || "Send permission was revoked.");
    }

    const currentSnapshot = await client.getDraftApprovalSnapshot(record.draftId);
    const currentDigest = await digestSendSnapshot(currentSnapshot);
    if (currentSnapshot.truncated || currentDigest !== record.payloadDigest) {
      return await decline("changed", "The Fastmail draft changed after this approval was created.");
    }

    const decisionResult = await decideSendApproval(env, approvalId, userLogin, "approve");
    if (!decisionResult.ok && decisionResult.record?.status !== "approved") {
      return { kind: "conflict", message: decisionResult.error, record: decisionResult.record, stage: "approve" };
    }
    const claim = await claimSendApproval(env, approvalId, userLogin, currentDigest);
    if (!claim.ok) {
      return { kind: "conflict", message: claim.error, record: claim.record, stage: "approve" };
    }
    if (claim.record.status === "sent") return { kind: "sent", record: claim.record };
    const claimId = claim.record.claimId;
    if (!claimId) throw new Error("Approval claim did not return an identifier");

    // Re-check the full payload digest inside submitDraft immediately before
    // EmailSubmission/set. The digest includes the immutable raw-message blobId.
    // If this throws, the JMAP request may have reached Fastmail even if its
    // response was lost, so the approval stays `sending` and can never be retried.
    const submissionId = await client.submitDraft(record.draftId, record.payloadDigest);
    const complete = await completeSendApproval(env, approvalId, claimId, submissionId);
    if (!complete.ok) throw new Error(complete.error);
    return { kind: "sent", record: complete.record };
  } catch (error) {
    return { kind: "uncertain", message: error instanceof Error ? error.message : String(error) };
  }
}
