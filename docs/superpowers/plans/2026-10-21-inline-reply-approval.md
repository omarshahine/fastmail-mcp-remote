# Inline Reply Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the MCP Apps send review card approve a send inline, but only for low-risk replies: `reply_to_email` drafts whose every recipient is the user or someone the user has already emailed. Every other send keeps the Access-authenticated approval page.

**Architecture:** Eligibility is decided on the server when the approval is created, stored immutably on the approval record, and bound to the draft digest. A new app-only tool, `ui_approve_send`, approves only records marked eligible and runs the same send path as the approval page (extracted into one shared function). The card shows a Send button only when the server says the record is eligible.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects (`SendApprovalStore`), JMAP, `@modelcontextprotocol/server` 2.3.1, Vitest.

**Spec:** The design agreed in conversation on 2026-10-21, restated here as the binding requirements:
1. Inline approval applies only to `reply_to_email`. `send_email`, `send_copy` and `forward_email` always use the approval page.
2. Every To and CC recipient must be one of the user's own identities or an address that appears in To/CC/BCC of a message in the user's Sent mailbox. Match the whole address, case-insensitively. Reply-all qualifies only if every recipient passes.
3. Drafts with BCC recipients or attachments are never eligible.
4. Eligibility is computed on the server when the approval is created, never from client input, and fails closed: any lookup error means not eligible.
5. Inline approval keeps every existing approval guarantee: single use, the 10-minute expiry, the owner check, the permission re-check, the draft digest re-check right before submission, and claim-based protection against duplicate sends.
6. `ui_approve_send` exists only where MCP Apps are enabled. Code Mode and 2026-07-28 clients without the `io.modelcontextprotocol/ui` extension never see it.
7. `INLINE_REPLY_APPROVAL` env var, `"on"` (default) or `"off"`, is a kill switch. `"off"` makes every approval page-only.

## Global Constraints

- Pinned dependency versions do not change (Agents 0.28.1, SDK 1.32.1, client/server 2.3.1).
- No real emails, domains, account IDs or team names in tracked files; tests use `example.com` addresses.
- New tools need a `TOOL_CATEGORIES` entry in `src/permissions.ts` and a `TOOL_ANNOTATIONS` entry in `src/tool-annotations.ts`. `test/tool-annotations.test.ts` enforces both.
- MCP Apps tools and `_meta.ui` are registered only when `server.appsEnabled`.
- At most 10 recipients (To + CC) are checked; more than 10 means not eligible.
- User-visible copy: card button `Send`, card secondary link `Review in browser`, ineligible hint none (the card looks exactly as it does today).
- Never use `rm`; use `trash`. No em dashes in docs or copy.

## Review Focus

- A recipient whose address contains a known address as a substring (`evilbob@example.com` when `bob@example.com` was emailed) must not qualify. JMAP `to`/`cc`/`bcc` filters are text matches, so the server must compare the fetched addresses exactly. Test in Task 2.
- A draft edited after the approval was created (for example a BCC added through `update_draft`) must not send. The digest re-check refuses it. Test in Task 4.
- Two `ui_approve_send` calls racing on one approval must submit once. Test in Task 4.
- A model calling `ui_approve_send` directly on a non-eligible approval (a `send_email`, or a reply to a stranger) must be refused without changing the approval's state. Test in Task 4.
- A JMAP failure during the Sent lookup must leave the reply page-only, not error the tool call. Test in Task 3.

---

### Task 1: Extract the shared send path

The approve branch of `handleSendApprovalDecision` (`src/send-approval-auth.ts:342-411`) re-checks permissions, re-checks the digest, decides, claims, submits and completes. Move it into one function both the page and the new tool call. Pure refactor: page behavior and HTML are unchanged.

**Files:**
- Create: `src/send-execution.ts`
- Modify: `src/send-approval-auth.ts:319-411`
- Test: `test/send-execution.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SendExecutionOutcome =
    | { kind: "sent"; record: SendApprovalRecord }
    | { kind: "refused"; reason: "permission" | "changed"; message: string; record?: SendApprovalRecord }
    | { kind: "conflict"; message: string; record?: SendApprovalRecord }
    | { kind: "uncertain"; message: string };
  export async function executeApprovedSend(
    env: Env, client: JmapClient, record: SendApprovalRecord, userLogin: string,
  ): Promise<SendExecutionOutcome>;
  ```
  `refused` means the approval was declined in the store (permission revoked or draft changed). `conflict` means the store refused the decide or claim (already decided, expired). `uncertain` means submission may have reached Fastmail; the approval stays `sending`.

- [ ] **Step 1: Write the failing tests** in `test/send-execution.test.ts`, reusing the in-memory store helpers from `test/send-approval.test.ts` (move shared helpers into `test/helpers/approval-store.ts` if both files need them):
  - `sends a pending approval once and returns kind "sent" with status "sent"`; asserts `client.submitDraft` called once with `(draftId, payloadDigest)`.
  - `returns refused/changed and declines the record when the draft digest changed`; asserts `submitDraft` not called and stored status `"declined"`.
  - `returns refused/permission when send permission was revoked`; asserts stored status `"declined"`.
  - `returns conflict for an already declined approval`; asserts `submitDraft` not called.
  - `returns uncertain and leaves the record sending when submitDraft throws`.
- [ ] **Step 2: Run** `npx vitest run test/send-execution.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `executeApprovedSend`** in `src/send-execution.ts` by moving the logic, then make `handleSendApprovalDecision` map each outcome to its existing page (`terminalPage`, `declineOutcome` with the same titles, copy and status codes as today).
- [ ] **Step 4: Run** `npx vitest run test/send-execution.test.ts test/send-approval.test.ts`. Expected: PASS, with no change to existing assertions.
- [ ] **Step 5: Commit** `refactor(send): share the approved-send path between page and tools`.

### Task 2: Known-recipient lookup and eligibility rule

**Files:**
- Modify: `src/jmap-client.ts` (new method next to `getIdentities`, line ~562)
- Create: `src/inline-approval.ts`
- Modify: `src/env.d.ts` (add `INLINE_REPLY_APPROVAL?: "on" | "off";`)
- Test: `test/inline-approval.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // JmapClient
  async findPreviouslySentRecipients(addresses: string[]): Promise<Set<string>>; // lowercased addresses that appear exactly in To/CC/BCC of a Sent-mailbox email
  // src/inline-approval.ts
  export const INLINE_RECIPIENT_LIMIT = 10;
  export function inlineReplyApprovalEnabled(env: Env): boolean; // false only when env.INLINE_REPLY_APPROVAL === "off"
  export async function isInlineReplyEligible(
    client: Pick<JmapClient, "getIdentities" | "findPreviouslySentRecipients">,
    snapshot: SendApprovalSnapshot,
  ): Promise<boolean>;
  ```
- `findPreviouslySentRecipients` makes one JMAP request. For each address it adds an `Email/query` (`filter: { operator: "AND", conditions: [{ inMailbox: sentId }, { operator: "OR", conditions: [{ to: a }, { cc: a }, { bcc: a }] }] }`, `limit: 20`) and an `Email/get` with `properties: ["to", "cc", "bcc"]` by back-reference. It returns only addresses that appear exactly (case-insensitive) in a fetched message. If there is no `sent`-role mailbox it returns an empty set.
- `isInlineReplyEligible` returns false when: the snapshot has any BCC, any attachment, zero To+CC recipients, or more than `INLINE_RECIPIENT_LIMIT`. Otherwise it returns true only if every To+CC address (lowercased) is an identity email or in the sent set. It catches every error and returns false.

- [ ] **Step 1: Write the failing tests** in `test/inline-approval.test.ts` with a fake client:
  - `eligible when every recipient was emailed before` (to `bob@example.com`, sent set `{bob@example.com}`) → `true`.
  - `eligible when the recipient is one of the user's identities` → `true`.
  - `case-insensitive match` (`Bob@Example.COM` vs sent `bob@example.com`) → `true`.
  - `not eligible when one CC recipient is unknown` → `false`.
  - `not eligible with any BCC`, `not eligible with an attachment`, `not eligible with 11 recipients` → `false`.
  - `fails closed when the lookup throws` → `false`.
  - `inlineReplyApprovalEnabled` is true for `undefined` and `"on"`, false for `"off"`.
  - JmapClient test with a stubbed `makeRequest`: `findPreviouslySentRecipients(["bob@example.com"])` returns an empty set when the fetched message's only recipient is `evilbob@example.com`, and `{ "bob@example.com" }` when it is `Bob@example.com`.
- [ ] **Step 2: Run** `npx vitest run test/inline-approval.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both functions as specified.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(send): known-recipient check for inline reply approval`.

### Task 3: Mark eligible approvals at creation

**Files:**
- Modify: `src/send-approval.ts:33-46` (record), `src/tools.ts` (`approvalResult` ~232, `prepareSendApproval` ~343, `registerAllTools` reply call site ~1058)
- Test: `test/send-approval.test.ts`

**Interfaces:**
- Consumes: `isInlineReplyEligible`, `inlineReplyApprovalEnabled` (Task 2).
- Produces: `SendApprovalRecord.inlineApproval?: boolean` (set only at `/create`, never changed by `/decide`, `/claim` or `/complete`). `prepareSendApproval(ctx, extra, toolName, draftId, options?: { appsEnabled?: boolean })`. `approvalResult` structuredContent gains `inlineApproval: boolean`.
- Rules: compute eligibility only when `toolName === "reply_to_email"`, `options.appsEnabled` is true and `inlineReplyApprovalEnabled(ctx.env)`, using the snapshot `prepareSendApproval` already reads. When the record is eligible, skip `requestModernApproval` (URL elicitation would block the card) and return `approvalResult`. For an eligible pending record the text is `Email prepared as a Fastmail draft. Nothing will be sent until you approve it.\n\nApprove it in the review card, or review and approve: ${url}\nDraft ID: ...\nApproval expires: ...`. Everything else keeps today's text.

- [ ] **Step 1: Write the failing tests** in the `outbound tool approval gate` describe block:
  - `marks a reply to a previously emailed sender as inline-eligible` → `structuredContent.inlineApproval === true` and the stored record has `inlineApproval: true`.
  - `does not mark send_email inline-eligible even to a known recipient` → `false`.
  - `does not mark a reply eligible when apps are disabled` (registerAllTools without `{ apps: true }`) → `false`.
  - `does not mark a reply eligible when INLINE_REPLY_APPROVAL is off` → `false`.
  - `keeps a reply page-only when the Sent lookup throws` → `false`, and the tool result is not an error.
  - `skips URL elicitation for an eligible reply on a modern client` → result is not `input_required`.
- [ ] **Step 2: Run** `npx vitest run test/send-approval.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the record field, the `prepareSendApproval` option, and pass `{ appsEnabled: server.appsEnabled }` from the `reply_to_email` call site.
- [ ] **Step 4: Run** `npx vitest run test/send-approval.test.ts test/send-review-app.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(send): mark low-risk replies eligible for inline approval`.

### Task 4: `ui_approve_send` app-only tool

**Files:**
- Modify: `src/tools.ts` (register after `ui_get_send_review`, ~1216), `src/apps/send-review.ts` (`SendReviewView`, `buildSendReviewView`), `src/permissions.ts` (`TOOL_CATEGORIES`: SEND), `src/tool-annotations.ts` (SEND group)
- Test: `test/send-review-app.test.ts`

**Interfaces:**
- Consumes: `executeApprovedSend` (Task 1), `SendApprovalRecord.inlineApproval` (Task 3).
- Produces: tool `ui_approve_send({ approvalId: string })`, `_meta: APP_ONLY`, registered only when `server.appsEnabled && shouldRegister("ui_approve_send")`. `SendReviewView.canApproveInline: boolean` (true only when `record.inlineApproval === true` and `record.status === "pending"`).
- Behavior, in order, all failures `isError: true` with no store change:
  1. `ctx.checkToolPermission("reply_to_email", { sendImmediately: true })` denial is returned as is.
  2. Record missing or owned by another user → `Approval not found.`
  3. `record.toolName !== "reply_to_email"` or `record.inlineApproval !== true` → `This email must be approved on the review page.` with `structuredContent: { approvalId, status: record.status, reviewUrl }`.
  4. Otherwise call `executeApprovedSend(ctx.env, ctx.getJmapClient(), record, currentUser)` and map the outcome: `sent` → `Email sent. Submission ID: ...` with `structuredContent { approvalId, status: "sent" }`; `refused`/`conflict` → `isError: true` with the outcome message and the record's status; `uncertain` → `isError: true`, message ends `Check Fastmail Sent before retrying.`, status `"sending"`.

- [ ] **Step 1: Write the failing tests:**
  - `ui_approve_send is app-only and absent without apps` (config `_meta` equals `APP_ONLY`; not registered with `apps: false`).
  - `sends an eligible reply once` → status `"sent"`, `submitDraft` called once.
  - `refuses a send_email approval and leaves it pending` → `isError`, stored status still `"pending"`, `submitDraft` not called.
  - `refuses a reply that was not marked eligible and leaves it pending`.
  - `refuses another user's approval`.
  - `does not send when the draft changed after preparation` (snapshot digest differs on approve) → `isError`, stored status `"declined"`.
  - `submits once under two concurrent calls` (`Promise.all` of two calls) → exactly one `"sent"` result, `submitDraft` called once.
  - `refuses an expired approval` (advance time past `expiresAt`) → `isError`, `submitDraft` not called.
  - `ui_get_send_review reports canApproveInline` → true for an eligible pending reply, false for `send_email`.
- [ ] **Step 2: Run** `npx vitest run test/send-review-app.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the tool, the view field, and the category and annotation entries.
- [ ] **Step 4: Run** `npx vitest run test/send-review-app.test.ts test/tool-annotations.test.ts test/tool-permissions.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(send): app-only inline approval for eligible replies`.

### Task 5: Send button in the review card

**Files:**
- Modify: `src/apps/send-review.ts` (`renderSendReviewApp`, ~90-265)
- Test: `test/send-review-app.test.ts` (`runReviewView`)

**Interfaces:**
- Consumes: `canApproveInline` (Task 4), `ui_approve_send` result shape (Task 4).
- UI: when the view is `pending` and `canApproveInline`, show a primary `Send` button and turn the existing primary button into a secondary `Review in browser` link. Otherwise the card is unchanged. Clicking `Send` disables it, calls `app.callTool("ui_approve_send", { approvalId })`, then: on `status: "sent"` render the existing sent state and stop polling; on `isError` show the result text in the message line, re-enable nothing, and refresh once through `ui_get_send_review`; on a bridge rejection re-enable the button and show `Could not reach Fastmail. Try again.`

- [ ] **Step 1: Write the failing tests** with `runReviewView`:
  - `shows Send only for inline-eligible pending approvals`.
  - `Send calls ui_approve_send once and renders the sent state` (click twice fast; `callTool` for `ui_approve_send` called once).
  - `shows the server message when inline approval is refused`.
  - `re-enables Send after a bridge failure`.
- [ ] **Step 2: Run** `npx vitest run test/send-review-app.test.ts`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the button, states and copy above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(apps): inline Send button on the review card for eligible replies`.

### Task 6: Docs, config and full verification

**Files:**
- Modify: `README.md` (send approval section), `AGENTS.md` (Configuration Reference plaintext vars table), `wrangler.jsonc.example` (`"INLINE_REPLY_APPROVAL": "on"` next to `SEND_APPROVAL_MODE`), `CHANGELOG.md` (Unreleased → Added), `cli/skill.md` and `openclaw-plugin/skills/fastmail/SKILL.md` only if they describe the approval flow.
- Test: `test/mcp-wire.test.ts`

- [ ] **Step 1: Write the failing wire test:** on the legacy lane `tools/list` includes `ui_approve_send` with `_meta.ui.visibility` `["app"]`; on the modern lane without the ui extension it is absent.
- [ ] **Step 2: Run** `npx vitest run test/mcp-wire.test.ts`. Expected: PASS if Task 4 registered it correctly, otherwise fix the registration.
- [ ] **Step 3: Write the docs.** Explain the rule in one paragraph: inline Send appears only for replies where every recipient is you or someone you have emailed before, with no BCC or attachments, and `INLINE_REPLY_APPROVAL=off` disables it. State the accepted risk: a compromised known contact, or injection inside an existing thread, could get a reply sent to that contact without the review page.
- [ ] **Step 4: Run** `npm test` and `npx tsc --noEmit`. Expected: all pass, no type errors.
- [ ] **Step 5: Commit** `docs: inline reply approval`.

After merge and deploy, verify manually in claude.ai: a reply to someone you have emailed shows `Send` and sends; a reply to a cold sender and a `send_email` show only `Review & approve`.
