/**
 * Extend the wrangler-generated Env interface with secrets that are set via
 * `wrangler secret put` and therefore not present in wrangler.jsonc vars.
 */
declare namespace Cloudflare {
  interface Env {
    ACTION_SIGNING_KEY: string;
    LOADER: WorkerLoader;
    /** Set to "true" to enable MCP elicitation-based send confirmation dialogs. Defaults to off. */
    ENABLE_SEND_CONFIRMATION?: string;
    /**
     * Comma-separated extra hostnames permitted as OAuth redirect_uri targets,
     * beyond loopback and the worker's own origin. Defaults to the Anthropic/
     * Claude domains when unset. See isAllowedRedirectUri in oauth-utils.ts.
     */
    ALLOWED_REDIRECT_HOSTS?: string;
    /**
     * Comma-separated browser origins allowed to call the HMAC-signed
     * /api/action/* endpoints. Unset means "*" (needed when the reading-digest
     * page is opened from a local file:// URL, which sends Origin: null).
     */
    ACTION_ALLOWED_ORIGINS?: string;
  }
}
