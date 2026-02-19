/**
 * CLI runner for the Fastmail OpenClaw plugin.
 *
 * Spawns the `fastmail` CLI as a child process and captures stdout.
 * The CLI handles auth, MCP connection, formatting, and cleanup internally.
 */

import { execFile } from "node:child_process";

export interface CliOptions {
  /** CLI command (default: "fastmail") */
  command: string;
  /** Timeout in milliseconds (default: 30000) */
  timeout: number;
}

const DEFAULT_OPTIONS: CliOptions = {
  command: "fastmail",
  timeout: 30_000,
};

let globalOptions: CliOptions = { ...DEFAULT_OPTIONS };

export function configure(opts: Partial<CliOptions>) {
  globalOptions = { ...DEFAULT_OPTIONS, ...opts };
}

/**
 * Run a fastmail CLI command and return stdout.
 * Throws on non-zero exit or timeout.
 */
export function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      globalOptions.command,
      args,
      {
        timeout: globalOptions.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: { ...process.env, NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
