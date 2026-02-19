/**
 * Authentication module for Fastmail CLI.
 *
 * Implements PKCE OAuth flow with a localhost callback server to obtain
 * Bearer tokens from the remote MCP Worker. Tokens are cached in
 * ~/.config/fastmail-cli/config.json (30-day TTL, matching the server).
 */

import { createServer, type Server } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "fastmail-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  url: string;
  clientId: string;
  teamName: string;
  token: string;
  tokenExpiresAt: string;
}

export async function loadConfig(): Promise<Config | null> {
  try {
    const data = await readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Start a localhost HTTP server on a random port to receive the OAuth callback.
 * Returns the port, a promise that resolves with the auth code, and the server
 * handle for cleanup.
 */
function startCallbackServer(): Promise<{
  port: number;
  codePromise: Promise<string>;
  server: Server;
}> {
  return new Promise((resolve, reject) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDesc = url.searchParams.get("error_description");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<h1>Authentication Failed</h1><p>${errorDesc || error}</p><p>You can close this tab.</p>`,
          );
          rejectCode(new Error(errorDesc || error));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Authentication Successful</h1><p>You can close this tab and return to the terminal.</p>",
          );
          resolveCode(code);
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()!;
      const port = typeof addr === "string" ? parseInt(addr) : addr.port;
      resolve({ port, codePromise, server });
    });
    server.on("error", reject);
  });
}

/** Prompt the user for input on the terminal. */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Run the full PKCE OAuth flow:
 * 1. Register a client (if first time)
 * 2. Start localhost callback server
 * 3. Open browser → CF Access auth
 * 4. Receive callback with auth code
 * 5. Exchange code + PKCE verifier for Bearer token
 * 6. Cache token to config
 */
export async function authenticate(
  url?: string,
  teamName?: string,
): Promise<void> {
  let config = await loadConfig();
  const baseUrl = url || config?.url;

  if (!baseUrl) {
    console.error(
      "Error: No URL provided. Run: fastmail auth --url <your-worker-url>",
    );
    process.exit(1);
  }

  // Resolve team name: CLI option > saved config > prompt
  let resolvedTeamName = teamName || config?.teamName;
  if (!resolvedTeamName) {
    resolvedTeamName = await prompt(
      "Cloudflare Access team name (e.g. 'myteam' from myteam.cloudflareaccess.com): ",
    );
    if (!resolvedTeamName) {
      console.error("Error: Team name is required for authentication.");
      process.exit(1);
    }
  }

  // Register client if needed
  let clientId = config?.clientId;
  if (!clientId || (url && url !== config?.url)) {
    console.log("Registering client...");
    const regResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "fastmail-cli",
        redirect_uris: ["http://127.0.0.1/callback"],
      }),
    });
    if (!regResponse.ok) {
      throw new Error(`Registration failed: ${await regResponse.text()}`);
    }
    const regData = (await regResponse.json()) as { client_id: string };
    clientId = regData.client_id;
  }

  // Generate PKCE pair
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Start localhost server
  const { port, codePromise, server } = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // Build authorization URL (pass team_name so Worker can construct CF Access URL)
  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    team_name: resolvedTeamName,
  });
  const authUrl = `${baseUrl}/mcp/authorize?${authParams}`;

  console.log("Opening browser for authentication...");
  console.log(`If browser doesn't open, visit:\n  ${authUrl}\n`);

  // Open browser
  const open = (await import("open")).default;
  await open(authUrl);

  // Wait for callback
  console.log("Waiting for authentication...");
  let code: string;
  try {
    code = await codePromise;
  } finally {
    server.close();
  }

  // Exchange code for token
  console.log("Exchanging code for token...");
  const tokenResponse = await fetch(`${baseUrl}/mcp/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token: string;
    expires_in: number;
  };

  // Save config
  const expiresAt = new Date(
    Date.now() + tokenData.expires_in * 1000,
  ).toISOString();
  await saveConfig({
    url: baseUrl,
    clientId,
    teamName: resolvedTeamName,
    token: tokenData.access_token,
    tokenExpiresAt: expiresAt,
  });

  console.log("Authentication successful!");
  console.log(
    `Token expires: ${new Date(expiresAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`,
  );
}

/** Load and validate the cached token, or exit with an error. */
export async function getToken(): Promise<{ url: string; token: string }> {
  const config = await loadConfig();
  if (!config?.token) {
    console.error(
      "Not authenticated. Run: fastmail auth --url <your-worker-url>",
    );
    process.exit(1);
  }

  if (new Date(config.tokenExpiresAt) < new Date()) {
    console.error("Token expired. Run: fastmail auth");
    process.exit(1);
  }

  return { url: config.url, token: config.token };
}

/** Display the current auth status. */
export async function checkAuthStatus(): Promise<void> {
  const config = await loadConfig();
  if (!config?.token) {
    console.log("Status: Not authenticated");
    console.log("Run: fastmail auth --url <your-worker-url>");
    return;
  }

  const expiresAt = new Date(config.tokenExpiresAt);
  const now = new Date();
  const daysLeft = Math.ceil(
    (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );

  console.log(`Status: ${daysLeft > 0 ? "Authenticated" : "Expired"}`);
  console.log(`Server: ${config.url}`);
  console.log(`Team:   ${config.teamName || "(not set)"}`);
  console.log(`Client: ${config.clientId}`);
  console.log(
    `Expires: ${expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} (${daysLeft > 0 ? `${daysLeft} days left` : "expired"})`,
  );
}
