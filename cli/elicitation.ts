/**
 * Terminal handling for MCP elicitation requests (URL and form mode).
 *
 * The CLI only declares elicitation support when it runs on an interactive
 * terminal. Non-interactive callers (OpenClaw execFile, pipes, CI) declare no
 * capability, so the server never asks them anything and nothing can block.
 */

import { createInterface } from "node:readline";
import type { ElicitRequestParams, ElicitResult } from "@modelcontextprotocol/client";

export function isInteractive(
  env: NodeJS.ProcessEnv = process.env,
  stdin: { isTTY?: boolean } = process.stdin,
  stderr: { isTTY?: boolean } = process.stderr,
): boolean {
  return Boolean(stdin.isTTY) && Boolean(stderr.isTTY) && env.FASTMAIL_NONINTERACTIVE !== "1";
}

export interface PromptIO {
  /** Returns the answer, or null on EOF or Ctrl-C. */
  ask(question: string): Promise<string | null>;
  write(text: string): void;
  openUrl(url: string): Promise<void>;
}

export function terminalIO(): PromptIO {
  return {
    ask(question) {
      return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        let settled = false;
        const done = (value: string | null) => {
          if (settled) return;
          settled = true;
          rl.close();
          resolve(value);
        };
        rl.on("close", () => done(null));
        rl.on("SIGINT", () => done(null));
        rl.question(question, (answer) => done(answer));
      });
    },
    write(text) {
      process.stderr.write(text);
    },
    async openUrl(url) {
      const { default: open } = await import("open");
      await open(url);
    },
  };
}

type Prop = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  enumNames?: string[];
  oneOf?: { const: string; title?: string }[];
};

const CANCEL: ElicitResult = { action: "cancel" };

async function askProperty(
  io: PromptIO,
  name: string,
  prop: Prop,
  required: boolean,
): Promise<{ value: unknown } | null> {
  const label = prop.title ?? name;
  if (prop.description) io.write(`${prop.description}\n`);

  if (prop.type === "boolean") {
    const def = prop.default === true;
    const hint = def ? "[Y/n]" : "[y/N]";
    const answer = await io.ask(`${label} ${hint}: `);
    if (answer === null) return null;
    const a = answer.trim().toLowerCase();
    if (a === "") return { value: def };
    return { value: a === "y" || a === "yes" };
  }

  if (prop.type === "number" || prop.type === "integer") {
    for (;;) {
      const answer = await io.ask(`${label}${prop.default !== undefined ? ` [${prop.default}]` : ""}: `);
      if (answer === null) return null;
      const t = answer.trim();
      if (t === "" && prop.default !== undefined) return { value: prop.default };
      if (t === "" && !required) return { value: undefined };
      const n = Number(t);
      const bad =
        t === "" ||
        Number.isNaN(n) ||
        (prop.type === "integer" && !Number.isInteger(n)) ||
        (prop.minimum !== undefined && n < prop.minimum) ||
        (prop.maximum !== undefined && n > prop.maximum);
      if (!bad) return { value: n };
      io.write("Invalid number.\n");
    }
  }

  const choices: { value: string; title: string }[] | null = prop.oneOf
    ? prop.oneOf.map((o) => ({ value: o.const, title: o.title ?? o.const }))
    : prop.enum
      ? prop.enum.map((v, i) => ({ value: v, title: prop.enumNames?.[i] ?? v }))
      : null;

  if (choices) {
    choices.forEach((c, i) => io.write(`  ${i + 1}) ${c.title}\n`));
    for (;;) {
      const answer = await io.ask(`${label} (1-${choices.length})${prop.default !== undefined ? ` [${prop.default}]` : ""}: `);
      if (answer === null) return null;
      const t = answer.trim();
      if (t === "" && prop.default !== undefined) return { value: prop.default };
      const idx = Number(t);
      if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) return { value: choices[idx - 1].value };
      const byValue = choices.find((c) => c.value === t);
      if (byValue) return { value: byValue.value };
      io.write("Invalid choice.\n");
    }
  }

  for (;;) {
    const answer = await io.ask(`${label}${prop.default !== undefined ? ` [${prop.default}]` : ""}: `);
    if (answer === null) return null;
    const t = answer;
    if (t === "" && prop.default !== undefined) return { value: prop.default };
    if (prop.minLength !== undefined && t.length < prop.minLength) {
      io.write(`Must be at least ${prop.minLength} characters.\n`);
      continue;
    }
    if (prop.maxLength !== undefined && t.length > prop.maxLength) {
      io.write(`Must be at most ${prop.maxLength} characters.\n`);
      continue;
    }
    if (t === "" && !required) return { value: undefined };
    return { value: t };
  }
}

export function createElicitationHandler(
  io: PromptIO,
): (request: { params: ElicitRequestParams }) => Promise<ElicitResult> {
  return async (request) => {
    const params = request.params as any;

    if (params.mode === "url") {
      let host = "";
      try {
        host = new URL(params.url).hostname;
      } catch {
        // Show the raw URL below; the user can still decline.
      }
      io.write(`${params.message}\n${params.url}\nhost: ${host}\n`);
      const answer = await io.ask("Open in browser? [y/N] (N declines) ");
      if (answer === null) return CANCEL;
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") {
        try {
          await io.openUrl(params.url);
        } catch {
          io.write("Could not open browser; open the URL above manually.\n");
        }
        return { action: "accept" };
      }
      return { action: "decline" };
    }

    io.write(`${params.message}\n`);
    const properties: Record<string, Prop> = params.requestedSchema?.properties ?? {};
    const required: string[] = params.requestedSchema?.required ?? [];
    const content: Record<string, unknown> = {};
    for (const [name, prop] of Object.entries(properties)) {
      const result = await askProperty(io, name, prop, required.includes(name));
      if (result === null) return CANCEL;
      if (result.value !== undefined) content[name] = result.value;
    }
    return { action: "accept", content } as ElicitResult;
  };
}
