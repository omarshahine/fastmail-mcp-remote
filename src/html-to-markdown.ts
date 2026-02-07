import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';

/**
 * Converts HTML email bodies to clean markdown optimized for LLM consumption.
 *
 * Aggressively strips noise: images (LLMs can't see them), tracking URLs,
 * layout tables, invisible characters, and excessive formatting. The goal
 * is minimum tokens for maximum semantic content.
 */

// DOM node interface for linkedom elements (Workers don't have global HTMLElement)
interface DomNode {
  nodeName: string;
  nodeType: number;
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  closest(selector: string): DomNode | null;
  childNodes: ArrayLike<DomNode>;
  parentNode: { removeChild(child: DomNode): void } | null;
  remove(): void;
}

/**
 * String-level HTML cleanup before DOM parsing.
 *
 * Targets Outlook/MSO artifacts and embedded noise that bloat the HTML
 * without contributing semantic content. Runs before parseHTML() to
 * prevent linkedom from wasting effort on junk nodes.
 */
function preprocessEmailHtml(html: string): string {
  return html
    // Remove Outlook conditional comments: <!--[if ...]>...<![endif]-->
    .replace(/<!--\[if[^]*?<!\[endif\]-->/gi, '')
    // Remove Outlook namespace tags: <o:p>, </o:p>, <o:OfficeDocumentSettings>, etc.
    .replace(/<\/?o:[^>]*>/gi, '')
    // Strip mso- styles from inline style attributes (keep other styles intact)
    .replace(/\bmso-[^;:"']+:[^;:"']+;?/gi, '')
    // Remove large base64 data URIs (>500 chars) — embedded images the LLM can't see
    .replace(/url\(["']?data:[^)]{500,}["']?\)/gi, '')
    .replace(/src=["']data:[^"']{500,}["']/gi, '')
    // Convert &nbsp; to regular spaces for cleaner text extraction
    .replace(/&nbsp;/gi, ' ');
}

/** Check if a table element is used for layout (not data). */
function isLayoutTable(table: DomNode): boolean {
  if (table.getAttribute('role') === 'presentation') return true;
  if (table.getAttribute('width') === '100%') return true;
  // Data tables have <th> headers — never treat those as layout
  const hasHeaders = table.querySelectorAll('th').length > 0;
  if (hasHeaders) return false;
  // cellpadding="0" + cellspacing="0" without headers is a strong layout signal
  if (table.getAttribute('cellpadding') === '0' && table.getAttribute('cellspacing') === '0') return true;
  return true; // No headers = likely layout
}

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  // Strip ALL images — LLMs cannot see images, so img tags are pure noise.
  // If the image has meaningful alt text, we keep that as plain text.
  service.addRule('allImages', {
    filter: 'img' as any,
    replacement: (_content: string, node: any) => {
      const alt = (node.getAttribute('alt') || '').trim();
      // Only keep alt text if it's meaningful (not just "logo", "icon", empty, etc.)
      if (alt && alt.length > 3 && !/^(logo|icon|image|img|photo|picture|banner|spacer|pixel)$/i.test(alt)) {
        return alt;
      }
      return '';
    },
  });

  // Strip ALL link URLs — LLMs can't click links, so URLs are wasted tokens.
  // Keep only the display text. For mailto: links, keep the email address.
  service.addRule('stripLinkUrls', {
    filter: 'a' as any,
    replacement: (content: string, node: any) => {
      const href = (node.getAttribute('href') || '').trim();
      const trimmed = content.trim();
      // For mailto: links, show the email address if it differs from display text
      if (href.startsWith('mailto:')) {
        const email = href.slice(7).split('?')[0];
        if (trimmed && trimmed !== email) return `${trimmed} (${email})`;
        return email || trimmed;
      }
      return trimmed;
    },
  });

  // Flatten layout tables: tables used for email layout (not data tables)
  service.addRule('layoutTables', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'TABLE') return false;
      return isLayoutTable(node);
    }) as TurndownService.FilterFunction,
    replacement: (content: string) => content + '\n\n',
  });

  // Flatten layout table rows/cells to just pass through content
  service.addRule('layoutTableRows', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'TR' && node.nodeName !== 'TBODY' && node.nodeName !== 'THEAD') return false;
      const table = node.closest('table');
      if (!table) return false;
      return isLayoutTable(table);
    }) as TurndownService.FilterFunction,
    replacement: (content: string) => content,
  });

  service.addRule('layoutTableCells', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'TD') return false;
      const table = node.closest('table');
      if (!table) return false;
      return isLayoutTable(table);
    }) as TurndownService.FilterFunction,
    replacement: (content: string) => {
      const trimmed = content.trim();
      return trimmed ? trimmed + '\n' : '';
    },
  });

  // Strip style and script tags entirely
  service.remove(['style'] as unknown as TurndownService.Filter);
  service.remove(['script'] as unknown as TurndownService.Filter);

  // Strip HTML comments
  service.addRule('comments', {
    filter: ((node: DomNode) => node.nodeType === 8) as TurndownService.FilterFunction,
    replacement: () => '',
  });

  // Strip <center> tags but keep content
  service.addRule('center', {
    filter: ['center'] as unknown as TurndownService.Filter,
    replacement: (content: string) => content,
  });

  return service;
}

/**
 * Clean up the markdown output for LLM consumption:
 * - Strip invisible Unicode characters (zero-width spaces, soft hyphens, preheader padding)
 * - Collapse excessive whitespace
 * - Remove empty markdown links
 * - Strip lines that are only punctuation/separators
 */
function cleanMarkdown(md: string): string {
  return md
    // Replace zero-width spaces and non-breaking spaces with regular spaces —
    // they serve as word boundaries in email HTML and preheader padding.
    // \u00A0 comes from &nbsp;/&#160; parsed by linkedom (not caught by string-level replacement)
    .replace(/[\u200B\u00A0]/g, ' ')
    // Strip other invisible Unicode characters (joiners, soft hyphens, preheader padding)
    .replace(/[\u200C\u200D\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2060\u2061\u2062\u2063\u2064\uFEFF]/g, '')
    // Collapse multiple spaces to single space (from zero-width space replacement)
    .replace(/ {2,}/g, ' ')
    // Remove empty markdown links: [](url) or [ ](url)
    .replace(/\[\s*\]\([^)]*\)/g, '')
    // Remove markdown links that contain only whitespace text
    .replace(/\[\s+\]\([^)]*\)/g, '')
    // Remove image-in-link leftovers: [![](url)](url) patterns
    .replace(/\[\s*!\[\s*\]\([^)]*\)\s*\]\([^)]*\)/g, '')
    // Deduplicate adjacent repeated phrases (e.g., "Amazon Alexa Amazon Alexa" → "Amazon Alexa")
    // This occurs when <a> wraps <img> with alt text — image rule emits alt, link rule emits text
    // Restricted to word chars + spaces to avoid collapsing legitimate repeated data like "100 100"
    .replace(/\b(\w[\w ]{1,78}\w)\s+\1\b/g, '$1')
    // Strip generic legal boilerplate lines (but preserve unsubscribe/preferences content)
    .replace(/^.*(?:©|all rights reserved|view in browser|view as a web page|view online version).*$/gim, '')
    // Collapse 3+ newlines to 2 (preserve paragraph breaks)
    .replace(/\n{3,}/g, '\n\n')
    // Remove lines that are only whitespace
    .replace(/^[ \t]+$/gm, '')
    // Remove trailing whitespace from lines
    .replace(/[ \t]+$/gm, '')
    // Remove lines that are only pipe separators (leftover from table stripping)
    .replace(/^\s*\|?\s*$/gm, '')
    // Final collapse of blank lines after all cleanup
    .replace(/\n{3,}/g, '\n\n')
    // Trim leading/trailing whitespace
    .trim();
}

// Singleton Turndown instance (stateless after creation)
let turndownInstance: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndownInstance) {
    turndownInstance = createTurndownService();
  }
  return turndownInstance;
}

/** CSS selectors for boilerplate elements to remove before conversion. */
const BOILERPLATE_SELECTORS = [
  '[class*="signature"]',
  '[id*="signature"]',
  '.gmail_extra',
  '.gmail_signature',
  '.yahoo_quoted',
].join(', ');

/** Tags that are considered empty if they have no text and no media children.
 *  Note: TD is intentionally excluded — removing empty cells shifts columns in data tables. */
const EMPTY_ELEMENT_TAGS = new Set([
  'SPAN', 'DIV', 'P', 'A', 'STRONG', 'EM', 'FONT', 'B', 'I', 'U',
]);

/** Tags that count as meaningful content inside otherwise empty elements. */
const MEANINGFUL_CHILDREN = new Set(['IMG', 'VIDEO', 'IFRAME', 'SVG', 'CANVAS']);

/**
 * Iteratively remove empty elements from the DOM.
 *
 * After stripping images and boilerplate, many wrapper elements (span, div, td)
 * become empty shells. Removing them in a single pass isn't enough because a
 * parent may only become empty after its children are removed. We loop until
 * no more removals occur (typically 2-3 passes).
 */
function removeEmptyElements(document: any): void {
  let removed = true;
  while (removed) {
    removed = false;
    for (const el of document.querySelectorAll(
      Array.from(EMPTY_ELEMENT_TAGS).join(', ').toLowerCase()
    )) {
      // Skip if element has meaningful text content
      if (el.textContent && el.textContent.trim().length > 0) continue;
      // Skip if element contains media children
      const hasMeaningful = Array.from(el.querySelectorAll('*') as ArrayLike<any>)
        .some((child: any) => MEANINGFUL_CHILDREN.has(child.nodeName));
      if (hasMeaningful) continue;
      el.remove();
      removed = true;
    }
  }
}

export function htmlToMarkdown(html: string): string {
  if (!html || html.trim().length === 0) {
    return '';
  }

  // Step 1: String-level cleanup (Outlook/MSO artifacts, base64 noise, &nbsp;)
  const cleaned = preprocessEmailHtml(html);

  // Step 2: Parse HTML using linkedom (Worker-compatible DOM implementation)
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${cleaned}</body></html>`);

  // Step 3: Remove non-content elements before conversion
  for (const el of document.querySelectorAll('style, script, meta, link')) {
    el.remove();
  }

  // Step 4: Remove boilerplate elements (signatures, Gmail/Yahoo wrappers)
  // Note: We intentionally preserve unsubscribe/footer content for newsletter agent
  for (const el of document.querySelectorAll(BOILERPLATE_SELECTORS)) {
    el.remove();
  }

  // Step 5: Remove empty elements iteratively (shells left after image/boilerplate removal)
  removeEmptyElements(document);

  // Step 6: Inject whitespace between block-level elements to prevent word concatenation.
  // Email HTML relies on CSS for visual spacing between elements; when we strip
  // styles and flatten layout, adjacent text from sibling elements concatenates.
  for (const el of document.querySelectorAll('div, p, td, th, li, br, h1, h2, h3, h4, h5, h6, section, article, blockquote')) {
    if (el.parentNode) {
      el.parentNode.insertBefore(document.createTextNode(' '), el);
    }
  }

  // Step 7: Turndown conversion (with improved layout table detection)
  const turndown = getTurndown();
  const markdown = turndown.turndown(document.body as unknown as TurndownService.Node);

  // Step 8: Post-processing (dedup, boilerplate text, whitespace cleanup)
  return cleanMarkdown(markdown);
}

/**
 * Format an email as LLM-friendly structured text.
 *
 * Returns a compact markdown document with:
 * - Header section (Subject, From, To, CC, Date)
 * - Body as clean markdown (no images, no tracking)
 * - Attachment list (if any)
 * - Metadata footer (emailId, threadId, messageId, etc.)
 */
export function formatEmailAsMarkdown(email: any): string {
  const parts: string[] = [];

  // Header section
  const subject = email.subject || '(no subject)';
  parts.push(`# ${subject}`);
  parts.push('');

  const from = email.from?.map((a: any) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ') || 'Unknown';
  parts.push(`**From:** ${from}`);

  const to = email.to?.map((a: any) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ');
  if (to) parts.push(`**To:** ${to}`);

  const cc = email.cc?.map((a: any) => a.name ? `${a.name} <${a.email}>` : a.email).join(', ');
  if (cc) parts.push(`**CC:** ${cc}`);

  if (email.receivedAt) {
    const date = new Date(email.receivedAt);
    parts.push(`**Date:** ${date.toLocaleString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })}`);
  }

  parts.push('');
  parts.push('---');
  parts.push('');

  // Body content — extract from bodyValues using partId references
  const bodyValues = email.bodyValues as Record<string, { value: string }> | undefined;
  const htmlPartId = email.htmlBody?.[0]?.partId;
  const textPartId = email.textBody?.[0]?.partId;

  const htmlContent = htmlPartId && bodyValues?.[htmlPartId]?.value;
  const textContent = textPartId && bodyValues?.[textPartId]?.value;

  if (htmlContent) {
    parts.push(htmlToMarkdown(htmlContent));
  } else if (textContent) {
    parts.push(textContent);
  } else if (email.preview) {
    parts.push(email.preview);
  }

  // Attachments
  if (email.attachments && email.attachments.length > 0) {
    parts.push('');
    parts.push('---');
    parts.push('');
    parts.push('**Attachments:**');
    for (const att of email.attachments) {
      const size = att.size ? ` (${formatFileSize(att.size)})` : '';
      parts.push(`- ${att.name || 'unnamed'}${size}`);
    }
  }

  // Metadata footer
  parts.push('');
  parts.push('---');
  parts.push('');
  const meta: string[] = [];
  if (email.id) meta.push(`emailId: ${email.id}`);
  if (email.threadId) meta.push(`threadId: ${email.threadId}`);
  if (email.messageId?.length) meta.push(`messageId: ${email.messageId[0]}`);
  if (email.inReplyTo?.length) meta.push(`inReplyTo: ${email.inReplyTo[0]}`);
  if (email.references?.length) meta.push(`references: ${email.references.join(', ')}`);
  if (meta.length > 0) {
    parts.push(meta.join(' | '));
  }

  return parts.join('\n');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
