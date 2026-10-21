/**
 * MCP Apps (2026-01-26) identifiers shared by the server and the app views.
 *
 * Kept local rather than imported from `@modelcontextprotocol/ext-apps` so the
 * pinned MCP package set stays untouched (no new runtime dependency).
 */

/** Extension id advertised under `capabilities.extensions`. */
export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

/** MIME type a host requires before it renders a `ui://` resource as an app. */
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

export const SEND_REVIEW_URI = "ui://fastmail/send-review.html";
export const EMAIL_READER_URI = "ui://fastmail/email-reader.html";

/** Tool `_meta` that hides a tool from the model; only app views may call it. */
export const APP_ONLY = { ui: { visibility: ["app"] } } as const;
