/**
 * Authentication for the Fastmail OpenClaw plugin.
 *
 * Credentials (workerUrl + bearerToken) are provided via plugin config,
 * enabling multi-user setups where each workspace has its own token.
 */

export interface Credentials {
  url: string;
  token: string;
}

/**
 * Resolve credentials from plugin config. Both fields are required.
 */
export function resolveCredentials(pluginConfig: {
  workerUrl?: string;
  bearerToken?: string;
}): Credentials {
  if (!pluginConfig.workerUrl) {
    throw new Error("Missing workerUrl in plugin config");
  }
  if (!pluginConfig.bearerToken) {
    throw new Error("Missing bearerToken in plugin config");
  }
  return { url: pluginConfig.workerUrl, token: pluginConfig.bearerToken };
}
