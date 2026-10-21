import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { transformSync } from "esbuild";
import { installBridge } from "../src/apps/bridge";
import { renderAppPage } from "../src/apps/page";
import {
  APP_ONLY,
  EMAIL_READER_URI,
  SEND_REVIEW_URI,
  UI_EXTENSION_ID,
  UI_MIME_TYPE,
} from "../src/apps/constants";
import { createToolRegistrar, legacyShapedModernServer, registerAllTools, type ToolContext, type ToolResult } from "../src/tools";
import { TOOL_ANNOTATIONS } from "../src/tool-annotations";
import { createFastmailMcpServer } from "../src/mcp-server";

type Listener = (event: { data: unknown; source?: unknown }) => void;

function fakeWindow() {
  const sent: any[] = [];
  const listeners: Listener[] = [];
  const observers: Array<() => void> = [];
  const parent = { postMessage: (msg: unknown) => sent.push(msg) };
  const win: any = {
    parent,
    document: { body: { scrollHeight: 321 }, documentElement: { scrollHeight: 321 } },
    addEventListener(type: string, cb: Listener) {
      if (type === "message") listeners.push(cb);
    },
    ResizeObserver: class {
      constructor(cb: () => void) {
        observers.push(cb);
      }
      observe() {}
    },
  };
  const dispatch = (data: unknown) => listeners.forEach((cb) => cb({ data, source: parent }));
  return { win, sent, dispatch, observers };
}

function install(win: any, fn: (w: any) => void = installBridge) {
  new Function("window", `(${fn.toString()})(window)`)(win);
}

/** Initialize the bridge and complete the ui/initialize handshake. */
function ready() {
  const fake = fakeWindow();
  install(fake.win);
  fake.dispatch({ jsonrpc: "2.0", id: fake.sent[0].id, result: {} });
  return fake;
}

describe("MCP Apps bridge", () => {
  it("installBridge is self-contained", () => {
    const { win } = fakeWindow();
    expect(() => install(win)).not.toThrow();
    expect(typeof win.fastmailApp.callTool).toBe("function");
  });

  it("stays self-contained after esbuild bundling with keepNames", () => {
    // wrangler bundles with keepNames, which injects a module-level __name()
    // helper into some function forms. The stringified bridge must not
    // reference it, or the page throws ReferenceError on load.
    const source = readFileSync(resolve(__dirname, "../src/apps/bridge.ts"), "utf8");
    const { code } = transformSync(source, { loader: "ts", keepNames: true, format: "cjs" });
    const mod: { exports: any } = { exports: {} };
    new Function("module", "exports", code)(mod, mod.exports);
    const { win } = fakeWindow();
    expect(() => install(win, mod.exports.installBridge)).not.toThrow();
    expect(mod.exports.installBridge.toString()).not.toContain("__name");
  });

  it("bridge sends ui/initialize then initialized after the response", () => {
    const { win, sent, dispatch } = fakeWindow();
    install(win);
    const first = sent[0];
    expect(first.jsonrpc).toBe("2.0");
    expect(first.method).toBe("ui/initialize");
    expect(first.params).toEqual({
      appInfo: { name: "fastmail", version: "1" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    });
    expect(sent).toHaveLength(1);
    dispatch({ jsonrpc: "2.0", id: first.id, result: {} });
    expect(sent[1].method).toBe("ui/notifications/initialized");
    expect(sent[1].id).toBeUndefined();
  });

  it("callTool resolves with the matching response", async () => {
    const { win, sent, dispatch } = ready();
    const promise = win.fastmailApp.callTool("get_email", { emailId: "e1" });
    const request = sent.find((m) => m.method === "tools/call");
    expect(request.params).toEqual({ name: "get_email", arguments: { emailId: "e1" } });
    dispatch({ jsonrpc: "2.0", id: request.id, result: { content: [] } });
    await expect(promise).resolves.toEqual({ content: [] });
  });

  it("callTool rejects on a JSON-RPC error", async () => {
    const { win, sent, dispatch } = ready();
    const promise = win.fastmailApp.callTool("get_email", { emailId: "e1" });
    const request = sent.find((m) => m.method === "tools/call");
    dispatch({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "nope" } });
    await expect(promise).rejects.toThrow("nope");
  });

  it("tool-input notification reaches onToolInput", () => {
    const { win, dispatch } = ready();
    const seen: unknown[] = [];
    win.fastmailApp.onToolInput((args: unknown) => seen.push(args));
    dispatch({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { emailId: "e1" } } });
    expect(seen).toEqual([{ emailId: "e1" }]);
  });

  it("tool-result notification reaches onToolResult", () => {
    const { win, dispatch } = ready();
    const seen: unknown[] = [];
    win.fastmailApp.onToolResult((result: unknown) => seen.push(result));
    const params = { content: [{ type: "text", text: "hi" }] };
    dispatch({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params });
    expect(seen).toEqual([params]);
  });

  it("delivers a tool result that arrived before the callback was registered", () => {
    const { win, dispatch } = ready();
    const params = { content: [] };
    dispatch({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params });
    const seen: unknown[] = [];
    win.fastmailApp.onToolResult((result: unknown) => seen.push(result));
    expect(seen).toEqual([params]);
  });

  it("openLink and sendMessage send the spec methods", () => {
    const { win, sent } = ready();
    win.fastmailApp.openLink("https://example.com/approve/send/abc");
    win.fastmailApp.sendMessage("hello");
    expect(sent.find((m) => m.method === "ui/open-link").params).toEqual({
      url: "https://example.com/approve/send/abc",
    });
    expect(sent.find((m) => m.method === "ui/message").params).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("reports size changes", () => {
    const { win, sent, observers } = ready();
    const sizes = () => sent.filter((m) => m.method === "ui/notifications/size-changed");
    expect(sizes().map((m) => m.params)).toEqual([{ height: 321 }]);
    win.document.documentElement.scrollHeight = 500;
    observers.forEach((cb) => cb());
    expect(sizes().map((m) => m.params)).toEqual([{ height: 321 }, { height: 500 }]);
  });

  it("sends the first size after initialized even if the observer fired earlier", () => {
    const fake = fakeWindow();
    // Browsers fire the initial observation before the host's init response;
    // model that by firing synchronously inside observe().
    fake.win.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe() {
        this.cb();
      }
    };
    install(fake.win);
    expect(fake.sent.map((m) => m.method)).toEqual(["ui/initialize"]);
    fake.dispatch({ jsonrpc: "2.0", id: fake.sent[0].id, result: {} });
    expect(fake.sent.map((m) => m.method)).toEqual([
      "ui/initialize",
      "ui/notifications/initialized",
      "ui/notifications/size-changed",
    ]);
    expect(fake.sent[2].params).toEqual({ height: 321 });
  });

  it("resource-teardown is answered", () => {
    const { sent, dispatch } = ready();
    dispatch({ jsonrpc: "2.0", id: "t1", method: "ui/resource-teardown", params: {} });
    const response = sent.find((m) => m.id === "t1");
    expect(response).toEqual({ jsonrpc: "2.0", id: "t1", result: {} });
  });

  it("ignores messages that are not from the host", () => {
    const { win, sent } = fakeWindow();
    const listeners: Listener[] = [];
    win.addEventListener = (_: string, cb: Listener) => listeners.push(cb);
    install(win);
    listeners.forEach((cb) => cb({ data: { jsonrpc: "2.0", id: sent[0].id, result: {} }, source: {} }));
    expect(sent).toHaveLength(1);
  });
});

describe("renderAppPage", () => {
  it("renderAppPage has a CSP and no external scripts", () => {
    const html = renderAppPage({ title: "Review", body: "<main></main>", script: "void 0;" });
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain(
      `content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src about: data:"`,
    );
    expect(html).toContain("fastmailApp");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("light-dark(");
  });

  it("escapes the title and runs the page script after the bridge", () => {
    const html = renderAppPage({ title: "<b>&", body: "", script: "window.__page = 1;" });
    expect(html).toContain("<title>&lt;b&gt;&amp;</title>");
    expect(html.indexOf("fastmailApp")).toBeLessThan(html.indexOf("window.__page = 1;"));
  });
});

describe("MCP Apps registration plumbing", () => {
  const ctx = (): ToolContext => ({
    env: {} as Env,
    getCurrentUser: () => "user@example.com",
    getJmapClient: vi.fn() as any,
    getContactsCalendarClient: vi.fn() as any,
    checkToolPermission: async () => null,
    guardResponse: vi.fn() as any,
  });

  function rawServer() {
    const tools = new Map<string, any>();
    const resources = new Map<string, any>();
    const server = {
      registerTool(name: string, config: unknown, handler: unknown) {
        tools.set(name, { config, handler });
      },
      registerResource(name: string, uri: string, config: unknown, read: unknown) {
        resources.set(name, { uri, config, read });
      },
    };
    return { server, tools, resources };
  }

  const read = async () => ({ contents: [] });

  it("forwards registerTool _meta and resources when apps are enabled", () => {
    const { server, tools, resources } = rawServer();
    const registrar = createToolRegistrar(server as never, ctx(), { apps: true });
    expect(registrar.appsEnabled).toBe(true);
    registrar.registerTool(
      "ui_probe",
      { description: "probe", inputSchema: { id: z.string() }, _meta: APP_ONLY },
      async () => ({ content: [] }),
    );
    registrar.resource("probe", SEND_REVIEW_URI, { mimeType: UI_MIME_TYPE }, read);
    const tool = tools.get("ui_probe");
    expect(tool.config._meta).toEqual(APP_ONLY);
    expect(tool.config.inputSchema.safeParse({ id: "x", extra: 1 }).success).toBe(false);
    expect(resources.get("probe")).toEqual({
      uri: SEND_REVIEW_URI,
      config: { mimeType: UI_MIME_TYPE },
      read,
    });
  });

  it("wraps registerTool handlers in the permission check", async () => {
    const { server, tools } = rawServer();
    const denied: ToolResult = { content: [{ type: "text", text: "Error: denied" }] };
    const registrar = createToolRegistrar(server as never, { ...ctx(), checkToolPermission: async () => denied }, { apps: true });
    const inner = vi.fn();
    registrar.registerTool("ui_probe", { description: "probe", inputSchema: {}, _meta: APP_ONLY }, inner);
    await expect(tools.get("ui_probe").handler({})).resolves.toBe(denied);
    expect(inner).not.toHaveBeenCalled();
  });

  it("is app-free without the apps option (Code Mode)", () => {
    const { server, tools, resources } = rawServer();
    const registrar = createToolRegistrar(server as never, ctx());
    expect(registrar.appsEnabled).toBe(false);
    registrar.registerTool(
      "get_probe",
      { description: "probe", inputSchema: {}, _meta: { ui: { resourceUri: EMAIL_READER_URI } } },
      async () => ({ content: [] }),
    );
    registrar.resource("probe", SEND_REVIEW_URI, { mimeType: UI_MIME_TYPE }, read);
    expect(tools.get("get_probe").config._meta).toBeUndefined();
    expect(resources.size).toBe(0);
  });

  it("is app-free when the server cannot register resources", () => {
    const tools = new Map<string, any>();
    const server = { registerTool: (name: string, config: unknown) => tools.set(name, config) };
    const registrar = createToolRegistrar(server as never, ctx(), { apps: true });
    expect(registrar.appsEnabled).toBe(false);
  });

  it("registerAllTools accepts the apps option", () => {
    const { server, tools, resources } = rawServer();
    registerAllTools(server as never, ctx(), undefined, { apps: true });
    expect(tools.size).toBeGreaterThan(0);
    expect([...resources.values()].map((resource: any) => resource.uri)).toEqual([SEND_REVIEW_URI, EMAIL_READER_URI]);
  });

  it("legacyShapedModernServer forwards _meta and resources to the v2 server", () => {
    const { server, tools, resources } = rawServer();
    const registrar = createToolRegistrar(legacyShapedModernServer(server as never), ctx(), { apps: true });
    expect(registrar.appsEnabled).toBe(true);
    registrar.registerTool(
      "get_email",
      { description: "probe", inputSchema: { id: z.string() }, _meta: { ui: { resourceUri: EMAIL_READER_URI } } },
      async () => ({ content: [] }),
    );
    registrar.resource("reader", EMAIL_READER_URI, { mimeType: UI_MIME_TYPE }, read);
    const tool = tools.get("get_email");
    expect(tool.config._meta).toEqual({ ui: { resourceUri: EMAIL_READER_URI } });
    expect(tool.config.annotations).toEqual(TOOL_ANNOTATIONS.get_email);
    expect(tool.config.inputSchema.safeParse({ id: "x", extra: 1 }).success).toBe(false);
    expect(resources.get("reader").uri).toBe(EMAIL_READER_URI);
  });

  it("the /mcp server advertises the MCP Apps extension", () => {
    const codec = { mint: vi.fn(), verify: vi.fn() } as any;
    const server = createFastmailMcpServer({
      env: { ACTION_SIGNING_KEY: "00".repeat(32) } as Env,
      userLogin: "user@example.com",
      requestStateCodec: codec,
    });
    expect(server.server.getCapabilities().extensions).toEqual({ [UI_EXTENSION_ID]: {} });
  });
});
