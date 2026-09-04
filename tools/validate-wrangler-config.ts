import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type WranglerConfig = {
  migrations?: Array<{ new_sqlite_classes?: string[] }>;
  durable_objects?: {
    bindings?: Array<{ name?: string; class_name?: string }>;
  };
};

function parseJsonc(source: string): WranglerConfig {
  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      stripped += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") stripped += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    stripped += char;
  }

  // JSONC permits trailing commas. Comments are gone, so a comma followed only
  // by whitespace and a closing bracket can be removed without touching data.
  let normalized = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (inString) {
      normalized += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    if (char === ",") {
      let nextIndex = index + 1;
      while (/\s/.test(stripped[nextIndex] || "")) nextIndex += 1;
      if (stripped[nextIndex] === "}" || stripped[nextIndex] === "]") continue;
    }
    normalized += char;
  }
  return JSON.parse(normalized) as WranglerConfig;
}

export function validateWranglerConfig(source: string): void {
  let config: WranglerConfig;
  try {
    config = parseJsonc(source);
  } catch {
    throw new Error("wrangler.jsonc is not valid JSONC");
  }

  const hasMigration = config.migrations?.some((migration) =>
    migration.new_sqlite_classes?.includes("OAuthCodeStore"),
  );
  const hasBinding = config.durable_objects?.bindings?.some((binding) =>
    binding.name === "AUTHORIZATION_CODES" && binding.class_name === "OAuthCodeStore",
  );

  if (!hasMigration || !hasBinding) {
    throw new Error(
      "wrangler.jsonc must include the OAuthCodeStore new_sqlite_classes migration " +
      "and AUTHORIZATION_CODES Durable Object binding. Copy both entries from wrangler.jsonc.example before deploying.",
    );
  }
}

async function main(): Promise<void> {
  const configPath = resolve(process.cwd(), "wrangler.jsonc");
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch {
    throw new Error("wrangler.jsonc is required for deployment. Copy wrangler.jsonc.example and fill in local values.");
  }
  validateWranglerConfig(source);
  console.log("Wrangler deployment configuration is ready.");
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
