import { parseHTML } from "linkedom";

const BLOCKED_ELEMENTS = [
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "svg",
  "math",
  "meta",
  "base",
  "link",
  "template",
].join(",");

const SAFE_STYLE_PROPERTIES = new Set([
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-transform",
  "white-space",
  "word-break",
  "overflow-wrap",
  "vertical-align",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "table-layout",
]);

const SAFE_ATTRIBUTES = new Set([
  "alt",
  "title",
  "dir",
  "lang",
  "align",
  "valign",
  "width",
  "height",
  "cellpadding",
  "cellspacing",
  "colspan",
  "rowspan",
  "border",
  "role",
  "class",
  "style",
]);

export function escapePreviewHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeInlineStyle(style: string): string {
  const withoutComments = style.replace(/\/\*[\s\S]*?\*\//g, "");
  const safe: string[] = [];
  for (const declaration of withoutComments.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !value) continue;
    if (/url\s*\(|expression\s*\(|@import|javascript:|data:|behavior\s*:|-moz-binding/i.test(value)) continue;
    safe.push(`${property}: ${value}`);
  }
  return safe.join("; ");
}

function removeComments(node: any): void {
  for (const child of Array.from(node.childNodes || []) as any[]) {
    if (child.nodeType === 8) child.remove();
    else removeComments(child);
  }
}

/**
 * Retain common email formatting while removing active content, navigation,
 * network fetches, and CSS features that could escape or obscure the preview.
 * The result is still rendered inside a sandboxed, CSP-restricted iframe.
 */
export function sanitizeEmailHtml(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  document.querySelectorAll(BLOCKED_ELEMENTS).forEach((element: any) => element.remove());
  removeComments(document.body);

  document.querySelectorAll("img").forEach((image: any) => {
    const placeholder = document.createElement("span");
    placeholder.setAttribute("class", "image-placeholder");
    const alt = String(image.getAttribute("alt") || "Image").trim();
    placeholder.textContent = `▧ ${alt || "Image"}`;
    image.replaceWith(placeholder);
  });

  document.querySelectorAll("*").forEach((element: any) => {
    for (const attribute of Array.from(element.attributes || []) as any[]) {
      const name = String(attribute.name).toLowerCase();
      if (!SAFE_ATTRIBUTES.has(name) || name.startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
    }
    const style = element.getAttribute("style");
    if (style !== null) {
      const sanitized = sanitizeInlineStyle(style);
      if (sanitized) element.setAttribute("style", sanitized);
      else element.removeAttribute("style");
    }
  });

  return document.body.innerHTML;
}

export function buildEmailPreviewDocument(htmlBody: string, textBody: string): string {
  const content = htmlBody.trim()
    ? sanitizeEmailHtml(htmlBody)
    : `<div class="plain-text">${escapePreviewHtml(textBody || "This email has no body.")}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
  <style>
    :root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; }
    html { background: #fff; }
    body { box-sizing: border-box; margin: 0; padding: 28px 30px 42px; color: #202124; background: #fff; font-size: 15px; line-height: 1.55; overflow-wrap: anywhere; }
    *, *::before, *::after { box-sizing: border-box; max-width: 100%; }
    table { max-width: 100% !important; }
    pre { white-space: pre-wrap; }
    a { color: inherit; text-decoration: underline; cursor: default; }
    .plain-text { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; }
    .image-placeholder { display: inline-block; margin: 4px 0; padding: 8px 10px; border: 1px dashed #c5cbd3; border-radius: 6px; color: #697482; background: #f7f8fa; font: 12px/1.3 Arial, sans-serif; }
  </style>
</head>
<body>${content}</body>
</html>`;
}
