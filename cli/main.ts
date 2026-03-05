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
import { authenticate, authenticateHeadless, checkAuthStatus, logout, getToken } from "./auth.js";
import { FastmailMcpClient } from "./mcp-client.js";
import { registerEmailCommands } from "./commands/email.js";
import { registerContactCommands } from "./commands/contacts.js";
import { registerCalendarCommands } from "./commands/calendar.js";
import { registerMemoCommands } from "./commands/memo.js";
import { EXIT, fatal } from "./exit-codes.js";

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
  .option("--headless", "Token paste flow for SSH / no-browser environments")
  .action(async (opts) => {
    try {
      if (opts.headless) {
        await authenticateHeadless(opts.url, opts.team);
      } else {
        await authenticate(opts.url, opts.team);
      }
    } catch (err: any) {
      fatal(`Auth failed: ${err.message}`, EXIT.AUTH);
    }
  });

auth
  .command("status")
  .description("Check authentication status")
  .action(async () => {
    await checkAuthStatus();
  });

auth
  .command("logout")
  .description("Remove cached credentials and log out")
  .action(async () => {
    await logout();
  });

// ── permissions command (queries server for tool availability) ───

program
  .command("permissions")
  .description("Show available tool categories based on account permissions")
  .option("--json", "Output as JSON for machine parsing")
  .action(async (opts) => {
    try {
      const result = await client.callTool("check_function_availability");
      const disabled: string[] = [];

      // Map server response → disabled category list
      if (!result.contacts?.available) disabled.push("CONTACTS");
      if (!result.calendar?.available) {
        disabled.push("CALENDAR_READ", "CALENDAR_WRITE");
      } else if (!result.calendar?.functions?.includes("create_calendar_event")) {
        disabled.push("CALENDAR_WRITE");
      }
      if (!result.email?.available) {
        disabled.push("EMAIL_READ", "INBOX_MANAGE", "DRAFT", "REPLY", "SEND");
      } else {
        if (!result.email?.functions?.includes("send_email")) disabled.push("SEND");
        if (!result.email?.functions?.includes("create_draft")) disabled.push("DRAFT");
        if (!result.email?.functions?.includes("reply_to_email")) disabled.push("REPLY");
        if (!result.email?.functions?.includes("mark_email_read")) disabled.push("INBOX_MANAGE");
      }

      if (opts.json) {
        console.log(JSON.stringify({ disabledCategories: disabled }));
      } else {
        console.log(`Role: ${result.role}`);
        console.log(`User: ${result.authenticatedUser}`);

        const allCategories = [
          "EMAIL_READ", "CONTACTS", "CALENDAR_READ", "CALENDAR_WRITE",
          "INBOX_MANAGE", "DRAFT", "REPLY", "SEND",
        ];
        const disabledSet = new Set(disabled);
        const enabled = allCategories.filter((c) => !disabledSet.has(c));

        console.log(`\nEnabled: ${enabled.join(", ") || "none"}`);
        if (disabled.length) {
          console.log(`Disabled: ${disabled.join(", ")}`);
        } else {
          console.log(`\nAll categories enabled.`);
        }
      }
    } catch (err: any) {
      if (opts.json) {
        console.log(JSON.stringify({ disabledCategories: [], error: err.message }));
      } else {
        console.error(`Failed to check permissions: ${err.message}`);
      }
      process.exit(EXIT.SERVER);
    }
  });

// ── describe command (runtime schema introspection) ─────────
// Ref: https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/

program
  .command("describe")
  .description("Show schema for a tool (or list all tools). Runtime introspection for agents.")
  .argument("[toolName]", "Tool name (omit to list all)")
  .option("--json", "JSON output")
  .action(async (toolName, opts) => {
    try {
      const tools = await client.listTools();

      if (!toolName) {
        // List all tools
        if (opts.json) {
          console.log(JSON.stringify(tools, null, 2));
        } else {
          console.log(`# Available Tools (${tools.length})\n`);
          for (const t of tools) {
            console.log(`${t.name}  ${t.description || ""}`);
          }
        }
        return;
      }

      // Find specific tool
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) {
        const suggestions = tools
          .filter((t) => t.name.includes(toolName))
          .map((t) => t.name);
        console.error(`Unknown tool: ${toolName}`);
        if (suggestions.length) {
          console.error(`Did you mean: ${suggestions.join(", ")}?`);
        }
        process.exit(EXIT.INPUT);
      }

      if (opts.json) {
        console.log(JSON.stringify(tool, null, 2));
      } else {
        console.log(`# ${tool.name}\n`);
        if (tool.description) console.log(`${tool.description}\n`);
        const schema = tool.inputSchema;
        if (schema?.properties) {
          console.log("Parameters:");
          const required = new Set(schema.required || []);
          for (const [name, prop] of Object.entries<any>(schema.properties)) {
            const req = required.has(name) ? " (required)" : "";
            const type = prop.type || "any";
            const desc = prop.description ? ` — ${prop.description}` : "";
            const def = prop.default !== undefined ? ` [default: ${JSON.stringify(prop.default)}]` : "";
            console.log(`  ${name}: ${type}${req}${desc}${def}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`Failed to describe tools: ${err.message}`);
      process.exit(EXIT.SERVER);
    }
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

  private async ensureReal(): Promise<FastmailMcpClient> {
    if (!this.realClient) {
      const { url, token } = await getToken();
      this.realClient = new FastmailMcpClient(url, token);
    }
    return this.realClient;
  }

  override async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    const c = await this.ensureReal();
    return c.callTool(name, args);
  }

  override async listTools(): Promise<{ name: string; description?: string; inputSchema: any }[]> {
    const c = await this.ensureReal();
    return c.listTools();
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
    const msg = err.message || String(err);
    if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("Not authenticated")) {
      fatal(`Error: ${msg}`, EXIT.AUTH);
    } else if (msg.includes("ECONNREFUSED") || msg.includes("ETIMEDOUT") || msg.includes("fetch failed")) {
      fatal(`Error: ${msg}`, EXIT.SERVER);
    }
    fatal(`Error: ${msg}`, EXIT.ERROR);
  } finally {
    await client.close();
  }
}

main();
