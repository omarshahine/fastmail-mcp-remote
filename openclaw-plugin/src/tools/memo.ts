/**
 * Memo (private notes) tools for the Fastmail OpenClaw plugin.
 * 1 read-only + 2 optional (create, delete).
 */

import type { OpenClawApi } from "../../index.js";
import { buildArgs, runTool } from "../cli-runner.js";

export function registerMemoTools(api: OpenClawApi, cli: string) {
  api.registerTool({
    name: "fastmail_get_memo",
    description: "Get the private memo on an email, if one exists.",
    parameters: {
      type: "object",
      properties: { emailId: { type: "string", description: "Email ID" } },
      required: ["emailId"],
    },
    execute: (_id, params: { emailId: string }) =>
      runTool(["memo", params.emailId], cli),
  });

  api.registerTool({
    name: "fastmail_create_memo",
    description: "Add a private memo to an email. Shown as a yellow highlight in Fastmail.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        text: { type: "string", description: "Memo text" },
      },
      required: ["emailId", "text"],
    },
    execute: (_id, params: { emailId: string; text: string }) =>
      runTool(buildArgs(["memo", "create", params.emailId], { text: params.text }), cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_delete_memo",
    description: "Delete the private memo on an email.",
    parameters: {
      type: "object",
      properties: { emailId: { type: "string", description: "Email ID" } },
      required: ["emailId"],
    },
    execute: (_id, params: { emailId: string }) =>
      runTool(["memo", "delete", params.emailId], cli),
  }, { optional: true });
}
