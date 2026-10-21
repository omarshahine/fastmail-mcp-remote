/**
 * Shared HTML shell for MCP Apps views.
 *
 * Everything is inline: the CSP forbids every network fetch, so a view can
 * only render what the tool result hands it and talk to the host over the
 * postMessage bridge.
 */

import { installBridge } from "./bridge";

export const APP_PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src about: data:";

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: light-dark(#ffffff, #1c1c1e);
  --fg: light-dark(#1d1d1f, #f2f2f7);
  --muted: light-dark(#6e6e73, #a1a1a6);
  --border: light-dark(#d2d2d7, #3a3a3c);
  --surface: light-dark(#f5f5f7, #2c2c2e);
  --accent: light-dark(#0b63ce, #4c9dff);
  --accent-fg: #ffffff;
  --danger: light-dark(#c4122f, #ff6b6b);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 12px 16px;
  overflow-wrap: anywhere;
}
.muted { color: var(--muted); }
button {
  font: inherit;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
`;

/**
 * Inline view helper: `unmark(value)` removes prompt-guard datamarking (the
 * UNTRUSTED_EXTERNAL_DATA markers and suspicious-content warnings) from every
 * string in a tool result before display. Mirrors `stripDatamarking` in
 * `cli/mcp-client.ts`. Interpolate it inside a view SCRIPT; views cannot
 * import modules at runtime.
 */
export const UNMARK_SCRIPT = String.raw`
  var unmark = function (value) {
    if (typeof value === "string") {
      return value
        .replace(/\[WARNING: The [^\]]*? below contains text patterns[^\]]*\]\s*/g, "")
        .replace(/\s?\[\/?UNTRUSTED_EXTERNAL_DATA_[^\]]+\]\s?/g, "");
    }
    if (Array.isArray(value)) return value.map(unmark);
    if (value && typeof value === "object") {
      var out = {};
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = unmark(value[key]);
      }
      return out;
    }
    return value;
  };
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a complete app document. `body` is trusted markup and `script` is a
 * trusted inline script; it runs after the bridge, so `window.fastmailApp`
 * exists. Never interpolate email content into either: pass it through the
 * tool result and render it with `textContent` in the view.
 */
export function renderAppPage(input: { title: string; body: string; script: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${APP_PAGE_CSP}">
<title>${escapeHtml(input.title)}</title>
<style>${STYLES}</style>
</head>
<body>
${input.body}
<script>(${installBridge.toString()})(window);</script>
<script>${input.script}</script>
</body>
</html>`;
}
