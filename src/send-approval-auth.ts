import { FastmailAuth } from "./fastmail-auth";
import { JmapClient } from "./jmap-client";
import {
  claimSendApproval,
  completeSendApproval,
  decideSendApproval,
  digestSendSnapshot,
  getSendApproval,
  type SendApprovalRecord,
  type SendApprovalSnapshot,
} from "./send-approval";
import {
  generateState,
  getAccessBaseUrl,
  isUserAllowed,
  verifyAccessIdToken,
} from "./oauth-utils";
import { getPermissionsConfig, getUserConfig, isToolAllowed } from "./permissions";
import { buildEmailPreviewDocument } from "./email-preview";

const AUTH_STATE_TTL_SECONDS = 10 * 60;

interface ApprovalAuthState {
  approvalId: string;
  userLogin: string;
  teamName: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" href="/favicon.png" type="image/png">
  <title>${escapeHtml(title)} | Fastmail</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 50% -10%, #dcecff 0, #f3f6fa 36%, #edf1f5 100%); color: #17212b; }
    main { width: min(880px, calc(100% - 32px)); margin: 42px auto 70px; }
    h1 { margin: 0; font-size: clamp(1.6rem, 4vw, 2.15rem); letter-spacing: -.035em; }
    h2 { margin: 0; font-size: 1rem; }
    p { line-height: 1.55; }
    .shell { overflow: hidden; background: rgba(255,255,255,.96); border: 1px solid rgba(178,190,203,.72); border-radius: 22px; box-shadow: 0 24px 70px rgba(31, 51, 72, .14), 0 2px 8px rgba(31, 51, 72, .05); }
    .header { padding: 28px 30px 22px; border-bottom: 1px solid #e5e9ee; }
    .helper { margin: 9px 0 0; color: #697482; font-size: .93rem; }
    .message { padding: 0 30px 26px; }
    .subject { margin: 0 -30px; padding: 22px 30px 18px; font-size: 1.25rem; font-weight: 750; letter-spacing: -.015em; overflow-wrap: anywhere; }
    .sender { display: grid; grid-template-columns: 42px minmax(0,1fr); gap: 12px; align-items: center; padding-bottom: 18px; }
    .avatar { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(145deg, #e1edff, #bdd7ff); color: #075ebf; font-weight: 850; }
    .sender-address { font-weight: 720; overflow-wrap: anywhere; }
    .recipient-line { margin-top: 3px; color: #687482; font-size: .82rem; overflow-wrap: anywhere; }
    .recipient-label { font-weight: 750; color: #4b5764; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip { display: inline-flex; align-items: center; padding: 5px 9px; border: 1px solid #dce3ea; border-radius: 999px; background: #f7f9fb; color: #44505d; font-size: .78rem; overflow-wrap: anywhere; }
    .chip.bcc { border-color: #f0c9a7; background: #fff7ef; color: #8b4c16; }
    .preview-frame-wrap { overflow: hidden; border: 1px solid #dfe5eb; border-radius: 13px; background: white; box-shadow: inset 0 1px 2px rgba(20,40,60,.03); }
    .preview-label { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 13px; border-bottom: 1px solid #e7ebef; background: #f7f9fb; color: #596573; font-size: .76rem; font-weight: 750; text-transform: uppercase; letter-spacing: .065em; }
    .safe-badge { display: inline-flex; align-items: center; gap: 5px; color: #347057; font-size: .69rem; letter-spacing: 0; text-transform: none; }
    iframe { display: block; width: 100%; height: 430px; border: 0; background: white; }
    .attachments { margin-top: 16px; }
    .attachment-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 9px; margin-top: 9px; }
    .attachment { display: grid; grid-template-columns: 34px minmax(0,1fr); align-items: center; gap: 10px; padding: 10px; border: 1px solid #e0e5ea; border-radius: 10px; background: #fafbfc; }
    .file-icon { display: grid; place-items: center; width: 34px; height: 38px; border-radius: 7px; background: #e7f0ff; color: #1769d2; font-size: .72rem; font-weight: 850; }
    .file-name { font-size: .84rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-meta { margin-top: 2px; color: #788390; font-size: .72rem; }
    details { margin-top: 13px; border: 1px solid #e1e6eb; border-radius: 10px; background: #fafbfc; }
    summary { padding: 11px 13px; cursor: pointer; color: #596573; font-size: .8rem; font-weight: 700; }
    .source { max-height: 260px; overflow: auto; margin: 0; padding: 0 13px 13px; white-space: pre-wrap; overflow-wrap: anywhere; color: #4c5865; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .decision-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 20px; padding-top: 18px; border-top: 1px solid #e5e9ee; }
    .expires { color: #6d7885; font-size: .78rem; }
    .actions { display: flex; gap: 10px; }
    button { min-height: 44px; border: 0; border-radius: 10px; padding: 10px 18px; font: inherit; font-weight: 760; cursor: pointer; transition: transform .12s ease, box-shadow .12s ease, background .12s ease; }
    button:hover { transform: translateY(-1px); }
    .approve { background: linear-gradient(180deg, #1877ec, #0961ce); color: white; box-shadow: 0 5px 14px rgba(9, 97, 206, .24); }
    .decline { border: 1px solid #d4dbe2; background: white; color: #394552; }
    .status { padding: 14px; border-radius: 10px; background: #edf5ff; }
    @media (prefers-color-scheme: dark) {
      body { background: radial-gradient(circle at 50% -10%, #182b42 0, #10161d 42%, #0c1117 100%); color: #e9eef3; }
      .shell { background: #171e26; border-color: #35404b; }
      .header, .decision-bar { border-color: #35404b; }
      .helper, .recipient-line, .expires { color: #9da9b5; }
      .recipient-label { color: #c3ccd5; }
      .chip, .preview-label, .attachment, details { background: #222b34; border-color: #3a4652; color: #cad2da; }
      .chip.bcc { background: #39291c; border-color: #68472d; color: #f3c69d; }
      .decline { background: #252d36; border-color: #45515d; color: #e9eef3; }
      .source, summary { color: #bec7d0; }
      .status { background: #1d334d; }
    }
    @media (max-width: 620px) {
      main { width: min(100% - 20px, 880px); margin-top: 20px; }
      .header, .message { padding-left: 18px; padding-right: 18px; }
      .subject { margin-left: -18px; margin-right: -18px; padding-left: 18px; padding-right: 18px; }
      iframe { height: 390px; }
      .decision-bar { align-items: stretch; flex-direction: column-reverse; }
      .actions { display: grid; grid-template-columns: 1fr 1fr; }
      button { padding-left: 10px; padding-right: 10px; }
    }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

function terminalPage(record: SendApprovalRecord): Response | null {
  if (record.status === "sent") {
    return page("Email sent", `<h1>Email sent</h1><p class="status">Submission ID: ${escapeHtml(record.submissionId || "unknown")}</p><p>You can close this tab.</p>`);
  }
  if (record.status === "declined") {
    return page("Send declined", '<h1>Email not sent</h1><p class="status">This send was declined. The prepared draft remains in Fastmail.</p>');
  }
  if (record.status === "expired") {
    return page("Approval expired", '<h1>Approval expired</h1><p class="status">Nothing was sent. Start the send again to create a fresh approval.</p>', 410);
  }
  if (record.status === "sending") {
    return page("Send in progress", '<h1>Send status needs checking</h1><p class="status">This approval has already started a send and cannot be retried. Check Fastmail Sent and Drafts.</p>', 409);
  }
  return null;
}

function declineOutcome(
  result: Awaited<ReturnType<typeof decideSendApproval>>,
  title: string,
  body: string,
  status = 200,
): Response {
  if (result.ok) return page(title, body, status);
  const terminal = result.record ? terminalPage(result.record) : null;
  if (terminal) return terminal;
  return page("Approval changed", `<h1>Email status changed</h1><p class="status">${escapeHtml(result.error)}</p>`, 409);
}

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function addressChips(addresses: string[], kind: "to" | "cc" | "bcc"): string {
  return addresses.map((address) => `<span class="chip ${kind}">${escapeHtml(address)}</span>`).join("");
}

export function renderSendApprovalReview(
  record: SendApprovalRecord,
  formToken: string,
  snapshot: SendApprovalSnapshot,
): Response {
  const previewDocument = buildEmailPreviewDocument(snapshot.htmlBody, snapshot.textBody);
  const attachments = snapshot.attachments.map((item) => {
    const extension = item.name.includes(".") ? item.name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE";
    return `<div class="attachment">
      <div class="file-icon">${escapeHtml(extension)}</div>
      <div><div class="file-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div><div class="file-meta">${escapeHtml(item.type)} · ${formatFileSize(item.size)}</div></div>
    </div>`;
  }).join("");
  const expires = new Date(record.expiresAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
  const initial = (snapshot.from.trim()[0] || "F").toUpperCase();

  return page("Approve email", `
    <section class="shell">
      <header class="header">
        <h1>Ready to send?</h1>
        <p class="helper">Check the recipients and message below.</p>
        <div class="decision-bar">
          <div class="expires">Approval expires ${escapeHtml(expires)} UTC</div>
          <form class="actions" method="post" action="/approve/send/${encodeURIComponent(record.id)}">
            <input type="hidden" name="token" value="${escapeHtml(formToken)}">
            <button class="decline" type="submit" name="decision" value="decline">Keep as draft</button>
            <button class="approve" type="submit" name="decision" value="approve">Approve and send</button>
          </form>
        </div>
      </header>
      <div class="message">
        <div class="subject">${escapeHtml(snapshot.subject || "(No subject)")}</div>
        <div class="sender">
          <div class="avatar" aria-hidden="true">${escapeHtml(initial)}</div>
          <div>
            <div class="sender-address">${escapeHtml(snapshot.from)}</div>
            <div class="recipient-line"><span class="recipient-label">To:</span> ${escapeHtml(snapshot.to.join(", ") || "No recipients")}</div>
            ${(snapshot.cc.length || snapshot.bcc.length) ? `<div class="chips">${addressChips(snapshot.cc, "cc")}${addressChips(snapshot.bcc, "bcc")}</div>` : ""}
          </div>
        </div>
        <div class="preview-frame-wrap">
          <div class="preview-label"><span>Email preview</span><span class="safe-badge">● Safe preview · links and remote images disabled</span></div>
          <iframe title="Email content preview" sandbox="" referrerpolicy="no-referrer" srcdoc="${escapeHtml(previewDocument)}"></iframe>
        </div>
        ${attachments ? `<section class="attachments"><h2>Attachments (${snapshot.attachments.length})</h2><div class="attachment-grid">${attachments}</div></section>` : ""}
        <details><summary>Plain-text version</summary><pre class="source">${escapeHtml(snapshot.textBody || "No plain-text alternative.")}</pre></details>
        <details><summary>HTML source</summary><pre class="source">${escapeHtml(snapshot.htmlBody || "No HTML alternative.")}</pre></details>
      </div>
    </section>
  `);
}

export async function handleSendApprovalStart(env: Env, url: URL): Promise<Response> {
  const pathParts = url.pathname.split("/").filter(Boolean);
  const approvalId = pathParts[pathParts.length - 1] || "";
  const record = await getSendApproval(env, approvalId);
  if (!record) return page("Approval not found", "<h1>Approval not found</h1><p>The link is invalid or no longer available.</p>", 404);

  if (!env.ACCESS_CLIENT_ID || !env.ACCESS_TEAM_NAME) {
    return page("Approval unavailable", "<h1>Approval unavailable</h1><p>Cloudflare Access is not configured.</p>", 500);
  }

  const state = generateState();
  const stateData: ApprovalAuthState = {
    approvalId,
    userLogin: record.userLogin,
    teamName: env.ACCESS_TEAM_NAME,
  };
  await env.OAUTH_KV.put(`send-approval-auth:${state}`, JSON.stringify(stateData), {
    expirationTtl: AUTH_STATE_TTL_SECONDS,
  });

  const accessBaseUrl = getAccessBaseUrl(env.ACCESS_TEAM_NAME);
  const accessAuthUrl = `${accessBaseUrl}/${env.ACCESS_CLIENT_ID}/authorization`;
  const params = new URLSearchParams({
    client_id: env.ACCESS_CLIENT_ID,
    redirect_uri: `${url.origin}/mcp/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  return new Response(null, { status: 302, headers: { Location: `${accessAuthUrl}?${params}` } });
}

export async function handleSendApprovalCallback(env: Env, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return page("Approval failed", "<h1>Approval failed</h1><p>Missing authorization response.</p>", 400);

  const stateJson = await env.OAUTH_KV.get(`send-approval-auth:${state}`);
  if (!stateJson) return page("Approval failed", "<h1>Approval failed</h1><p>The authorization request expired.</p>", 400);
  await env.OAUTH_KV.delete(`send-approval-auth:${state}`);
  const stateData = JSON.parse(stateJson) as ApprovalAuthState;

  try {
    if (!env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET) throw new Error("Cloudflare Access is not configured");
    const tokenResponse = await fetch(`${getAccessBaseUrl(stateData.teamName)}/${env.ACCESS_CLIENT_ID}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.ACCESS_CLIENT_ID,
        client_secret: env.ACCESS_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/mcp/callback`,
      }),
    });
    if (!tokenResponse.ok) throw new Error("Cloudflare Access token exchange failed");
    const tokenData = await tokenResponse.json<{ id_token?: string }>();
    if (!tokenData.id_token) throw new Error("Cloudflare Access did not return an identity token");
    const identity = await verifyAccessIdToken(tokenData.id_token, {
      teamName: stateData.teamName,
      clientId: env.ACCESS_CLIENT_ID,
    });
    if (!isUserAllowed(identity.email, env.ALLOWED_USERS || "")) throw new Error("User is not allowed");
    if (identity.email.toLowerCase() !== stateData.userLogin.toLowerCase()) throw new Error("Approval user does not match the sender");

    const record = await getSendApproval(env, stateData.approvalId);
    if (!record) throw new Error("Approval no longer exists");
    const terminal = terminalPage(record);
    if (terminal) return terminal;

    const reviewClient = new JmapClient(new FastmailAuth({ apiToken: env.FASTMAIL_API_TOKEN }));
    const snapshot = await reviewClient.getDraftApprovalSnapshot(record.draftId);
    const currentDigest = await digestSendSnapshot(snapshot);
    if (snapshot.truncated || currentDigest !== record.payloadDigest) {
      const declined = await decideSendApproval(env, record.id, identity.email, "decline");
      return declineOutcome(
        declined,
        "Draft changed",
        '<h1>Email not sent</h1><p class="status">The draft changed or is too large to review safely. Start the send again after reviewing it in Fastmail.</p>',
        409,
      );
    }

    const formToken = generateState();
    await env.OAUTH_KV.put(`send-approval-form:${formToken}`, JSON.stringify({
      approvalId: record.id,
      userLogin: identity.email,
    }), { expirationTtl: AUTH_STATE_TTL_SECONDS });
    return renderSendApprovalReview(record, formToken, snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return page("Approval failed", `<h1>Approval failed</h1><p>${escapeHtml(message)}</p>`, 403);
  }
}

export async function handleSendApprovalDecision(env: Env, request: Request, approvalId: string): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get("token") || "");
  const decision = form.get("decision") === "approve" ? "approve" : "decline";
  const tokenJson = token ? await env.OAUTH_KV.get(`send-approval-form:${token}`) : null;
  if (!tokenJson) return page("Approval failed", "<h1>Approval failed</h1><p>The form expired or was already used.</p>", 403);
  await env.OAUTH_KV.delete(`send-approval-form:${token}`);
  const tokenData = JSON.parse(tokenJson) as { approvalId: string; userLogin: string };
  if (tokenData.approvalId !== approvalId) return page("Approval failed", "<h1>Approval failed</h1><p>The form does not match this email.</p>", 403);

  const record = await getSendApproval(env, approvalId);
  if (!record) return page("Approval not found", "<h1>Approval not found</h1>", 404);
  const terminal = terminalPage(record);
  if (terminal) return terminal;

  if (decision === "decline") {
    const declined = await decideSendApproval(env, approvalId, tokenData.userLogin, "decline");
    return declineOutcome(
      declined,
      "Send declined",
      '<h1>Email not sent</h1><p class="status">The prepared draft remains in Fastmail.</p>',
    );
  }

  const client = new JmapClient(new FastmailAuth({ apiToken: env.FASTMAIL_API_TOKEN }));
  try {
    const permissions = await getPermissionsConfig(env.OAUTH_KV);
    const userConfig = getUserConfig(permissions, tokenData.userLogin);
    const allowed = isToolAllowed(
      userConfig,
      record.toolName,
      record.toolName === "reply_to_email" ? { sendImmediately: true } : undefined,
    );
    if (!allowed.allowed) {
      const declined = await decideSendApproval(env, approvalId, tokenData.userLogin, "decline");
      return declineOutcome(
        declined,
        "Permission denied",
        `<h1>Email not sent</h1><p class="status">${escapeHtml(allowed.error || "Send permission was revoked.")}</p>`,
        403,
      );
    }

    const currentSnapshot = await client.getDraftApprovalSnapshot(record.draftId);
    const currentDigest = await digestSendSnapshot(currentSnapshot);
    if (currentSnapshot.truncated || currentDigest !== record.payloadDigest) {
      const declined = await decideSendApproval(env, approvalId, tokenData.userLogin, "decline");
      return declineOutcome(
        declined,
        "Draft changed",
        '<h1>Email not sent</h1><p class="status">The Fastmail draft changed after this approval was created. Start the send again to review the current version.</p>',
        409,
      );
    }

    const decisionResult = await decideSendApproval(env, approvalId, tokenData.userLogin, "approve");
    if (!decisionResult.ok && decisionResult.record?.status !== "approved") {
      const final = decisionResult.record ? terminalPage(decisionResult.record) : null;
      return final || page("Approval failed", `<h1>Approval failed</h1><p>${escapeHtml(decisionResult.error)}</p>`, 409);
    }
    const claim = await claimSendApproval(env, approvalId, tokenData.userLogin, currentDigest);
    if (!claim.ok) {
      const final = claim.record ? terminalPage(claim.record) : null;
      return final || page("Approval failed", `<h1>Approval failed</h1><p>${escapeHtml(claim.error)}</p>`, 409);
    }
    if (claim.record.status === "sent") return terminalPage(claim.record)!;
    const claimId = claim.record.claimId;
    if (!claimId) throw new Error("Approval claim did not return an identifier");

    try {
      const submissionId = await client.submitDraft(record.draftId);
      const complete = await completeSendApproval(env, approvalId, claimId, submissionId);
      if (!complete.ok) throw new Error(complete.error);
      return terminalPage(complete.record)!;
    } catch (error) {
      // The JMAP request may have reached Fastmail even if its response was lost.
      // Keep the approval in `sending` so a retry can never submit a duplicate.
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return page("Send status uncertain", `<h1>Send status needs checking</h1><p class="status">${escapeHtml(message)}</p><p>For safety, this approval cannot be retried. Check Fastmail Sent and Drafts before starting another send.</p>`, 502);
  }
}
