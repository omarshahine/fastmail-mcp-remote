/**
 * The view side of the MCP Apps host bridge: JSON-RPC 2.0 over postMessage.
 *
 * `installBridge` is embedded into each app page with
 * `Function.prototype.toString`, so it must be self-contained: no imports, no
 * references to module scope, and no syntax that makes esbuild inject a helper.
 * wrangler bundles with `keepNames`, which wraps named function declarations
 * and functions assigned to variables in a module-level `__name()` call that
 * would not exist inside the page. Helpers are therefore object-method
 * shorthand or anonymous callbacks, which keepNames leaves alone
 * (`test/mcp-apps-bridge.test.ts` checks this against a real esbuild run).
 *
 * Exposes `window.fastmailApp`:
 * - `onToolInput(cb)`: tool arguments from `ui/notifications/tool-input`
 * - `onToolResult(cb)`: the tool result from `ui/notifications/tool-result`
 * - `callTool(name, args)`: a `tools/call` request through the host
 * - `openLink(url)`: `ui/open-link`, used to open the approval page
 * - `sendMessage(text)`: `ui/message` as a user turn
 *
 * A notification that arrives before its callback is registered is replayed
 * to the callback, because hosts may push input/results right after
 * initialization while the page script is still wiring up.
 */
export function installBridge(win: any): void {
  var host = win.parent;
  var state: any = {
    nextId: 1,
    pending: {} as Record<string, { resolve: (value: any) => void; reject: (error: any) => void }>,
    inputCallbacks: [] as Array<(args: Record<string, unknown>) => void>,
    resultCallbacks: [] as Array<(result: any) => void>,
    lastInput: undefined as any,
    lastResult: undefined as any,
    hasInput: false,
    hasResult: false,
    lastHeight: -1,
    post(message: any) {
      host.postMessage(message, "*");
    },
    // Callback form, so a response is handled synchronously in the message
    // event (initialization relies on that ordering).
    call(method: string, params: any, resolve: (value: any) => void, reject: (error: any) => void) {
      var id = state.nextId++;
      state.pending[id] = { resolve: resolve, reject: reject };
      state.post({ jsonrpc: "2.0", id: id, method: method, params: params });
    },
    request(method: string, params: any): Promise<any> {
      return new Promise((resolve, reject) => state.call(method, params, resolve, reject));
    },
    notify(method: string, params?: any) {
      var message: any = { jsonrpc: "2.0", method: method };
      if (params !== undefined) message.params = params;
      state.post(message);
    },
    reportSize() {
      var doc = win.document;
      var height = Math.ceil(
        (doc && doc.documentElement && doc.documentElement.scrollHeight) ||
          (doc && doc.body && doc.body.scrollHeight) ||
          0,
      );
      if (height === state.lastHeight) return;
      state.lastHeight = height;
      state.notify("ui/notifications/size-changed", { height: height });
    },
  };

  win.addEventListener("message", (event: any) => {
    if (event.source !== host) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;

    // A response to one of our requests.
    if (message.method === undefined && message.id !== undefined) {
      var entry = state.pending[message.id];
      if (!entry) return;
      delete state.pending[message.id];
      if (message.error) {
        var error: any = new Error(message.error.message || "MCP Apps request failed");
        error.code = message.error.code;
        error.data = message.error.data;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method === "ui/notifications/tool-input") {
      var args = (message.params && message.params.arguments) || {};
      state.lastInput = args;
      state.hasInput = true;
      state.inputCallbacks.forEach((cb: any) => cb(args));
      return;
    }

    if (message.method === "ui/notifications/tool-result") {
      state.lastResult = message.params;
      state.hasResult = true;
      state.resultCallbacks.forEach((cb: any) => cb(message.params));
      return;
    }

    // Requests from the host must always be answered.
    if (message.id !== undefined) {
      if (message.method === "ui/resource-teardown") {
        state.post({ jsonrpc: "2.0", id: message.id, result: {} });
      } else {
        state.post({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found: " + message.method },
        });
      }
    }
  });

  win.fastmailApp = {
    onToolInput(cb: (args: Record<string, unknown>) => void): void {
      state.inputCallbacks.push(cb);
      if (state.hasInput) cb(state.lastInput);
    },
    onToolResult(cb: (result: any) => void): void {
      state.resultCallbacks.push(cb);
      if (state.hasResult) cb(state.lastResult);
    },
    callTool(name: string, args: Record<string, unknown>): Promise<any> {
      return state.request("tools/call", { name: name, arguments: args || {} });
    },
    openLink(url: string): Promise<void> {
      return state.request("ui/open-link", { url: url }).then(() => undefined);
    },
    sendMessage(text: string): Promise<void> {
      return state
        .request("ui/message", { role: "user", content: [{ type: "text", text: text }] })
        .then(() => undefined);
    },
  };

  state.call(
    "ui/initialize",
    {
      appInfo: { name: "fastmail", version: "1" },
      appCapabilities: {},
      protocolVersion: "2026-01-26",
    },
    () => {
      state.notify("ui/notifications/initialized");
      state.reportSize();
    },
    () => undefined,
  );

  if (typeof win.ResizeObserver === "function" && win.document && win.document.body) {
    new win.ResizeObserver(() => state.reportSize()).observe(win.document.body);
  }
}
