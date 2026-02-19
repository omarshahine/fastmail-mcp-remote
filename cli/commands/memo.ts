/**
 * Memo (private notes) commands for the Fastmail CLI.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
import { formatMemo } from "../formatters.js";

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
    .action(async (emailId, opts) => {
      const result = await client.callTool("create_memo", {
        emailId,
        text: opts.text,
      });
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });

  memo
    .command("delete <emailId>")
    .description("Delete the memo on an email")
    .action(async (emailId) => {
      const result = await client.callTool("delete_memo", { emailId });
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });
}
