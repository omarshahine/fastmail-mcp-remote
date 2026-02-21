/**
 * CLI runner for the Fastmail OpenClaw plugin.
 *
 * Shells out to the `fastmail` CLI using execFile (no shell, no injection risk).
 * All formatting is handled by the CLI; the plugin is just a thin adapter.
 */

import { execFile } from "node:child_process";

/** OpenClaw tool response format. */
export type ToolResponse = { content: Array<{ type: string; text: string }> };

/**
 * Run the fastmail CLI with the given args.
 * Returns stdout on success; throws on non-zero exit or timeout.
 */
export function execCli(args: string[], cli: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr.trim() || err.message || "CLI command failed";
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Build CLI args from positional args and named flags.
 *
 * - undefined/null values are skipped
 * - boolean true becomes `--flag`, false is skipped
 * - arrays expand to `--flag val1 --flag val2`
 * - everything else becomes `--flag value`
 */
export function buildArgs(
  positional: string[],
  flags: Record<string, string | number | boolean | string[] | undefined | null> = {},
): string[] {
  const args = [...positional];
  for (const [key, val] of Object.entries(flags)) {
    if (val === undefined || val === null || val === false) continue;
    const flag = key.length === 1 ? `-${key}` : `--${key}`;
    if (val === true) {
      args.push(flag);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        args.push(flag, item);
      }
    } else {
      args.push(flag, String(val));
    }
  }
  return args;
}

/**
 * Run a CLI command and wrap the output as an OpenClaw tool response.
 * Errors are returned as error text, never thrown.
 */
export async function runTool(args: string[], cli: string): Promise<ToolResponse> {
  try {
    const text = await execCli(args, cli);
    return { content: [{ type: "text", text: text.trimEnd() }] };
  } catch (err: any) {
    const msg = err?.message || "Unknown error";
    return { content: [{ type: "text", text: `Error: ${msg}` }] };
  }
}
