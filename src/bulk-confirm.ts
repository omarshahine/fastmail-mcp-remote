/**
 * Form-elicitation confirmation for large bulk delete/move operations.
 *
 * On 2026-07-28 clients that declare form elicitation, `bulk_delete` and
 * `bulk_move` with BULK_CONFIRM_THRESHOLD or more emails return
 * `input_required` with a yes/no form before touching the mailbox. The retry
 * carries an HMAC-signed `requestState` that pins the tool, the exact id set
 * (as a digest), the target mailbox and the user, so a confirmation cannot be
 * reused for a different operation. Clients without form support (2025-era,
 * Code Mode, headless CLI) proceed as before, gated by tool annotations.
 */

import { inputRequired, inputResponse, type InputRequiredResult } from "@modelcontextprotocol/server";
import type { ToolContext, ToolResult } from "./tools";

export const BULK_CONFIRM_THRESHOLD = 25;

export interface BulkConfirmRequestState {
  kind: "bulk_confirm";
  toolName: "bulk_delete" | "bulk_move";
  idsDigest: string;
  targetMailboxId?: string;
  userLogin: string;
}

/** SHA-256 hex of the sorted, de-duplicated ids joined by newlines. */
export async function digestEmailIds(ids: string[]): Promise<string> {
  const canonical = [...new Set(ids)].sort().join("\n");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * True when the client declared form elicitation. Per the spec an empty
 * `elicitation: {}` object means form mode only.
 */
export function supportsFormElicitation(caps: any): boolean {
  const elicitation = caps?.elicitation;
  if (!elicitation || typeof elicitation !== "object") return false;
  return "form" in elicitation || Object.keys(elicitation).length === 0;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ text, type: "text" }], ...(isError ? { isError: true } : {}) };
}

/**
 * Ask for confirmation before a large bulk operation. Returns `null` when the
 * operation should proceed, otherwise a result to return from the handler.
 */
export async function gateBulkOperation(
  ctx: ToolContext,
  extra: any,
  op: { toolName: "bulk_delete" | "bulk_move"; emailIds: string[]; targetMailboxId?: string },
): Promise<ToolResult | InputRequiredResult | null> {
  const n = op.emailIds.length;
  if (n < BULK_CONFIRM_THRESHOLD || !ctx.modernMcp || !extra?.mcpReq) return null;
  if (!supportsFormElicitation(ctx.modernMcp.getClientCapabilities())) return null;

  const currentUser = ctx.getCurrentUser();
  if (!currentUser) throw new Error("Authenticated user is unavailable");
  const idsDigest = await digestEmailIds(op.emailIds);

  const state = extra.mcpReq.requestState?.() as Partial<BulkConfirmRequestState> | undefined;
  if (state) {
    const matches =
      state.kind === "bulk_confirm" &&
      state.toolName === op.toolName &&
      state.idsDigest === idsDigest &&
      state.targetMailboxId === op.targetMailboxId &&
      typeof state.userLogin === "string" &&
      state.userLogin.toLowerCase() === currentUser.toLowerCase();
    if (!matches) return textResult("Bulk confirmation state does not match this request.", true);

    const response = inputResponse(extra.mcpReq.inputResponses, "confirm");
    if (response.kind === "elicit") {
      if (response.action === "accept" && response.content?.confirm === true) return null;
      return textResult(
        op.toolName === "bulk_delete" ? "Cancelled: no emails were deleted." : "Cancelled: no emails were moved.",
      );
    }
  }

  let message: string;
  let verb: string;
  if (op.toolName === "bulk_delete") {
    message = `Move ${n} emails to Trash?`;
    verb = "delete";
  } else {
    // The name is cosmetic; a failed lookup must not block the confirmation.
    let mailboxName = op.targetMailboxId;
    try {
      const mailboxes = await ctx.getJmapClient().getMailboxes();
      mailboxName = mailboxes.find((m: any) => m.id === op.targetMailboxId)?.name || op.targetMailboxId;
    } catch {
      // Fall back to the mailbox id.
    }
    message = `Move ${n} emails to "${mailboxName}"?`;
    verb = "move";
  }

  const nextState: BulkConfirmRequestState = {
    kind: "bulk_confirm",
    toolName: op.toolName,
    idsDigest,
    ...(op.targetMailboxId !== undefined ? { targetMailboxId: op.targetMailboxId } : {}),
    userLogin: currentUser,
  };
  const requestState = await ctx.modernMcp.mintRequestState(nextState, extra);
  return inputRequired({
    inputRequests: {
      confirm: inputRequired.elicit({
        message,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: { type: "boolean", title: `Yes, ${verb} ${n} emails`, default: false },
          },
          required: ["confirm"],
        },
      }),
    },
    requestState,
  });
}
