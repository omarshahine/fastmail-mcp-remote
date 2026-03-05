/**
 * Memo (private notes) commands for the Fastmail CLI.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
import { formatMemo } from "../formatters.js";
import { validateIds, validateTextArg } from "../validate.js";

/** Format a dry-run preview for a mutation command. */
function dryRunOutput(toolName: string, args: Record<string, unknown>): void {
  console.log(`[dry-run] Would call: ${toolName}`);
  console.log(JSON.stringify(args, null, 2));
}

export function registerMemoCommands(
  program: Command,
  client: FastmailMcpClient,
) {
  const memo = program
    .command("memo")
    .description("Memo operations. Pass an email ID to view its memo.")
    .argument("[emailId]", "Email ID to get memo for")
    .option("--json", "JSON output")
    .action(async (emailId, opts) => {
      if (!emailId) return memo.help();
      validateIds(emailId, "email ID");
      const data = await client.callTool("get_memo", { emailId });
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatMemo(data));
      }
    });

  memo
    .command("create <emailId>")
    .description("Add a private memo to an email")
    .requiredOption("--text <text>", "Memo text")
    .option("--dry-run", "Preview what would be created without creating")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");
      validateTextArg(opts.text, "memo text");

      const args = { emailId, text: opts.text };
      if (opts.dryRun) return dryRunOutput("create_memo", args);

      const result = await client.callTool("create_memo", args);
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });

  memo
    .command("delete <emailId>")
    .description("Delete the memo on an email")
    .option("--dry-run", "Preview what would be deleted without deleting")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");

      const args = { emailId };
      if (opts.dryRun) return dryRunOutput("delete_memo", args);

      const result = await client.callTool("delete_memo", args);
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });
}
