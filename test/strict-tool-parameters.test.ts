import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerAllTools, legacyShapedModernServer, strictShape, type ToolContext } from "../src/tools";

/**
 * Regression guard for 2026-09-06.
 *
 * `z.object(shape)` is not strict, so a misspelled filter used to be stripped
 * with no error and the tool ran unfiltered -- indistinguishable from a filter
 * that matched everything. `advanced_search({ inMailbox })` (the parameter is
 * `mailboxId`; `inMailbox` is the JMAP-level name it maps onto) searched the
 * whole account instead of one mailbox, and `list_emails({ offset })` silently
 * re-returned the first page because there is no offset parameter. 200 emails
 * were moved out of folders they had never been in.
 */
describe("tool parameters are strict", () => {
  /** Capture the inputSchema each tool registers with. */
  function schemasFor(): Map<string, z.ZodTypeAny> {
    const schemas = new Map<string, z.ZodTypeAny>();
    const server = {
      registerTool(name: string, config: { inputSchema?: z.ZodTypeAny }) {
        if (config?.inputSchema) schemas.set(name, config.inputSchema);
      },
      tool() {},
    };
    registerAllTools(server as never, {} as never);
    return schemas;
  }

  it("registers every tool with a strict schema when the server supports it", () => {
    const schemas = schemasFor();
    expect(schemas.size).toBeGreaterThan(0);
    for (const [name, schema] of schemas) {
      const result = (schema as z.ZodObject<never>).safeParse({
        __definitely_not_a_real_parameter__: 1,
      });
      expect(result.success, `${name} accepted an unknown parameter`).toBe(false);
    }
  });

  it("rejects advanced_search({ inMailbox }) and names the offending key", () => {
    const schema = schemasFor().get("advanced_search");
    expect(schema).toBeDefined();
    const bad = schema!.safeParse({ inMailbox: "P3v0E", before: "2026-08-31T00:00:00Z" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("inMailbox");
    // the real parameter still works
    expect(schema!.safeParse({ mailboxId: "P3v0E" }).success).toBe(true);
  });

  it("rejects list_emails({ offset }), which never existed", () => {
    const schema = schemasFor().get("list_emails");
    expect(schema).toBeDefined();
    expect(schema!.safeParse({ mailboxId: "P3v0E", limit: 200, offset: 200 }).success).toBe(false);
    expect(schema!.safeParse({ mailboxId: "P3v0E", limit: 200 }).success).toBe(true);
  });

  it("makes the legacy-shaped modern server strict too", () => {
    // index.ts wires registerAllTools(legacyShapedModernServer(server), ...).
    // That shim exposes only tool(), so the registerTool capability check in
    // registerAllTools falls through -- the shim has to apply strictness
    // itself or every tool served through it is silently exempt.
    const schemas = new Map<string, z.ZodTypeAny>();
    const modern = {
      registerTool(name: string, config: { inputSchema?: z.ZodTypeAny }) {
        if (config?.inputSchema) schemas.set(name, config.inputSchema);
      },
    };
    registerAllTools(legacyShapedModernServer(modern as never), {} as never);
    expect(schemas.size).toBeGreaterThan(0);
    const advanced = schemas.get("advanced_search");
    expect(advanced).toBeDefined();
    expect(advanced!.safeParse({ inMailbox: "P3v0E" }).success).toBe(false);
    expect(advanced!.safeParse({ mailboxId: "P3v0E" }).success).toBe(true);
  });

  it("strictShape passes through a schema instance and non-objects", () => {
    const already = z.object({ a: z.string() }).strict();
    expect(strictShape(already)).toBe(already);
    expect(strictShape(undefined)).toBeUndefined();
  });

  it("still registers on a server that only implements tool()", () => {
    const registered: string[] = [];
    const server = { tool: (name: string) => registered.push(name) };
    registerAllTools(server as never, {} as never);
    expect(registered.length).toBeGreaterThan(0);
  });
});
