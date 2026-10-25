import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateWranglerConfig } from "../tools/validate-wrangler-config";

describe("Wrangler deployment preflight", () => {
  it("accepts the tracked deployment template", async () => {
    const template = await readFile(resolve(process.cwd(), "wrangler.jsonc.example"), "utf8");
    expect(() => validateWranglerConfig(template)).not.toThrow();
  });

  it("rejects a config without the required migration and binding", () => {
    expect(() => validateWranglerConfig(`{
      "migrations": [],
      "durable_objects": { "bindings": [] }
    }`)).toThrow("Copy both entries from wrangler.jsonc.example");
  });

  it("parses JSONC comments, URLs, and trailing commas", () => {
    expect(() => validateWranglerConfig(`{
      // A URL must not be mistaken for a line comment.
      "route": "https://worker.example/path",
      "migrations": [{ "new_sqlite_classes": ["OAuthCodeStore",], }],
      "durable_objects": {
        "bindings": [{
          "name": "AUTHORIZATION_CODES",
          "class_name": "OAuthCodeStore",
        }],
      },
    }`)).not.toThrow();
  });

  it("config deleting FastmailMCP validates", async () => {
    const template = await readFile(resolve(process.cwd(), "wrangler.jsonc.example"), "utf8");
    expect(template).toContain('"deleted_classes"');
    expect(template).not.toContain("MCP_OBJECT");
    expect(() => validateWranglerConfig(template)).not.toThrow();
  });

  it("binding to a deleted class fails validation", () => {
    expect(() => validateWranglerConfig(`{
      "migrations": [
        { "new_sqlite_classes": ["OAuthCodeStore"], "tag": "v3" },
        { "deleted_classes": ["FastmailMCP"], "tag": "v4" }
      ],
      "durable_objects": {
        "bindings": [
          { "name": "AUTHORIZATION_CODES", "class_name": "OAuthCodeStore" },
          { "name": "MCP_OBJECT", "class_name": "FastmailMCP" }
        ]
      }
    }`)).toThrow("FastmailMCP");
  });
});
