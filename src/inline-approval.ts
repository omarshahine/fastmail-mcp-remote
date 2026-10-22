import type { JmapClient } from "./jmap-client";
import type { SendApprovalSnapshot } from "./send-approval";

/** Most To+CC recipients a reply may have and still be approved inline. */
export const INLINE_RECIPIENT_LIMIT = 10;

export function inlineReplyApprovalEnabled(env: Env): boolean {
  return env.INLINE_REPLY_APPROVAL !== "off";
}

function normalize(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * A reply is low risk when it has no BCC or attachments and every To/CC
 * recipient is the user or someone the user has already emailed. Any failure
 * answers false so the full review card is shown.
 */
export async function isInlineReplyEligible(
  client: Pick<JmapClient, "getIdentities" | "findPreviouslySentRecipients">,
  snapshot: SendApprovalSnapshot,
): Promise<boolean> {
  try {
    if (snapshot.bcc.length > 0 || snapshot.attachments.length > 0) return false;
    const recipients = [...new Set([...snapshot.to, ...snapshot.cc].map(normalize))];
    if (snapshot.to.length + snapshot.cc.length === 0) return false;
    if (snapshot.to.length + snapshot.cc.length > INLINE_RECIPIENT_LIMIT) return false;

    const identities = await client.getIdentities();
    const own = new Set(
      identities.map((identity: any) => normalize(String(identity?.email ?? ""))),
    );
    const unknown = recipients.filter((address) => !own.has(address));
    if (unknown.length === 0) return true;

    const known = await client.findPreviouslySentRecipients(unknown);
    return unknown.every((address) => known.has(address));
  } catch {
    return false;
  }
}
