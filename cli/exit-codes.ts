/**
 * Granular exit codes for agent-friendly error discrimination.
 *
 * Agents can distinguish auth vs input vs server failures without parsing stderr.
 * Ref: https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/
 */

export const EXIT = {
  SUCCESS: 0,
  /** Generic / unknown error */
  ERROR: 1,
  /** Authentication failure (expired token, 401, no credentials) */
  AUTH: 2,
  /** Invalid input (bad args, validation rejection) */
  INPUT: 3,
  /** Remote server / network error */
  SERVER: 4,
  /** Permission denied (role-based access control) */
  PERMISSION: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Print to stderr and throw with an exit code (allows finally blocks to run). */
export function fatal(message: string, code: ExitCode = EXIT.ERROR): never {
  console.error(message);
  const err = new Error(message) as Error & { exitCode: ExitCode };
  err.exitCode = code;
  throw err;
}
