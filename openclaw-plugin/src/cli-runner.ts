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
/**
 * Drop lines that are runtime noise rather than failure information.
 *
 * The CLI runs under `npx tsx`, and Node emits warnings on stderr that have
 * nothing to do with whether the command worked, e.g.
 *
 *   (node:22244) [DEP0205] DeprecationWarning: `module.register()` is deprecated.
 *   (Use `node --trace-deprecation ...` to show where the warning was created)
 *
 * Those arrive BEFORE the real error, so taking stderr wholesale reports the
 * warning as the cause. That happened for real: an MCP request timeout was
 * reported everywhere as a "runtime deprecation error" and sent the entire
 * diagnosis in the wrong direction.
 */
function stripRuntimeNoise(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (/^\(node:\d+\)/.test(t)) return false; // (node:NNN) ...Warning: ...
      if (/^\(Use `node --trace-/.test(t)) return false; // its follow-up hint
      return true;
    })
    .join("\n")
    .trim();
}

export function execCli(args: string[], cli: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Prefer real stderr content, but never let runtime noise stand in for
        // the actual failure. If stderr is nothing but warnings, fall through to
        // err.message, which at least carries the exit code or timeout.
        const meaningful = stripRuntimeNoise(stderr);
        const msg = meaningful || err.message || "CLI command failed";
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
