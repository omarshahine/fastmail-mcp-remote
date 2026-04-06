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
  }
}
