/**
 * Authentication check for the Fastmail OpenClaw plugin.
 *
 * Verifies a cached token exists at ~/.config/fastmail-cli/config.json
 * (shared with the CLI). Does NOT perform interactive authentication.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_FILE = join(homedir(), ".config", "fastmail-cli", "config.json");

interface Config {
  url: string;
  token: string;
  tokenExpiresAt: string;
}

/** Check that a valid (non-expired) CLI token exists. Throws if not. */
export async function ensureAuthenticated(): Promise<void> {
  let config: Config;
  try {
    const data = await readFile(CONFIG_FILE, "utf-8");
    config = JSON.parse(data);
  } catch {
    throw new Error(
      "Not authenticated. Run: fastmail auth --url <your-worker-url>",
    );
  }

  if (!config.token) {
    throw new Error(
      "Not authenticated. Run: fastmail auth --url <your-worker-url>",
    );
  }

  if (new Date(config.tokenExpiresAt) < new Date()) {
    throw new Error("Token expired. Run: fastmail auth");
  }
}
