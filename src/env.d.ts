/**
 * Extend the wrangler-generated Env interface with secrets that are set via
 * `wrangler secret put` and therefore not present in wrangler.jsonc vars.
 */
declare namespace Cloudflare {
  interface Env {
    ACTION_SIGNING_KEY: string;
    LOADER: WorkerLoader;
    /** Server-enforced outbound mail policy. Defaults to "required". */
    SEND_APPROVAL_MODE?: "off" | "client" | "required";
    /** One Durable Object per short-lived outbound approval. */
    SEND_APPROVALS: DurableObjectNamespace;
    /** One Durable Object per short-lived OAuth authorization code. */
    AUTHORIZATION_CODES: DurableObjectNamespace;
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

// The generated worker-configuration.d.ts comes from the local, gitignored
// wrangler config and may lag a newly added binding until the operator copies
// the updated template. Keep source and tests typed during that transition.
interface Env {
  AUTHORIZATION_CODES: DurableObjectNamespace;
}
