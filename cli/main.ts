#!/usr/bin/env tsx
/**
 * Fastmail CLI — token-efficient access to Fastmail via the remote MCP server.
 *
 * Usage:
 *   fastmail auth --url https://your-worker.example.com  # Authenticate
 *   fastmail inbox                                        # Recent inbox emails
 *   fastmail email <id>                                   # Read an email
 *   fastmail email search <query>                         # Search emails
 *   fastmail --help                                       # All commands
 *
 * The CLI calls the remote MCP Worker (preserving delegate access control)
 * and formats responses as compact text to save tokens when used via Claude.
 */

import { Command } from "commander";
import { authenticate, checkAuthStatus, getToken } from "./auth.js";
import { FastmailMcpClient } from "./mcp-client.js";
import { registerEmailCommands } from "./commands/email.js";
import { registerContactCommands } from "./commands/contacts.js";
import { registerCalendarCommands } from "./commands/calendar.js";
import { registerMemoCommands } from "./commands/memo.js";

const program = new Command("fastmail")
  .version("1.0.0")
  .description(
    "Token-efficient Fastmail CLI via remote MCP server.\n" +
      "Run 'fastmail auth --url <url>' first to authenticate.",
  )
  .enablePositionalOptions();

// ── auth command (no MCP client needed) ────────────────────

const auth = program
  .command("auth")
  .description("Authenticate with the Fastmail MCP server")
  .option("--url <url>", "Worker URL (required on first run)")
  .option("--team <name>", "Cloudflare Access team name (e.g. 'myteam')")
  .action(async (opts) => {
    try {
      await authenticate(opts.url, opts.team);
    } catch (err: any) {
      console.error(`Auth failed: ${err.message}`);
      process.exit(1);
    }
  });

auth
  .command("status")
  .description("Check authentication status")
  .action(async () => {
    await checkAuthStatus();
  });

// ── All other commands need an MCP client ──────────────────
// We need a way to inject the client into command registrations.
// Since Commander parses synchronously but actions are async,
// we create a proxy client that lazy-connects on first callTool().
class LazyClient extends FastmailMcpClient {
  private initialized = false;
  private realClient: FastmailMcpClient | null = null;

  constructor() {
    // Dummy super call — we override callTool to lazy-init
    super("", "");
  }

  override async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    if (!this.realClient) {
      const { url, token } = await getToken();
      this.realClient = new FastmailMcpClient(url, token);
    }
    return this.realClient.callTool(name, args);
  }

  override async close(): Promise<void> {
    if (this.realClient) await this.realClient.close();
  }
}

const client = new LazyClient();

// Register all command groups
registerEmailCommands(program, client);
registerContactCommands(program, client);
registerCalendarCommands(program, client);
registerMemoCommands(program, client);

// ── Parse and execute ──────────────────────────────────────

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err: any) {
    if (err.code === "commander.helpDisplayed") return;
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
