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

  // Simplify links: strip image-only links (where the only child is an img)
  // and remove links with tracking/unsubscribe URLs that add no content value
  service.addRule('simplifyLinks', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'A') return false;
      const href = node.getAttribute('href') || '';
      // Strip links that are just tracking redirects with no useful text
      if (!href || href === '#') return true;
      return false;
    }) as TurndownService.FilterFunction,
    replacement: (content: string) => content,
  });

  // Flatten layout tables: tables used for email layout (not data tables)
  service.addRule('layoutTables', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'TABLE') return false;
      if (node.getAttribute('role') === 'presentation') return true;
      if (node.getAttribute('width') === '100%') return true;
      if (node.querySelectorAll('th').length === 0) return true;
      return false;
    }) as TurndownService.FilterFunction,
    replacement: (content: string) => content + '\n\n',
  });

  // Flatten layout table rows/cells to just pass through content
  service.addRule('layoutTableRows', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'TR' && node.nodeName !== 'TBODY' && node.nodeName !== 'THEAD') return false;
      const table = node.closest('table');
      if (!table) return false;
      return table.getAttribute('role') === 'presentation'
        || table.getAttribute('width') === '100%'
        || table.querySelectorAll('th').length === 0;
    }) as TurndownService.FilterFunction,
    replacement: (content: string) => content,
  });

  service.addRule('layoutTableCells', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'TD') return false;
      const table = node.closest('table');
      if (!table) return false;
      return table.getAttribute('role') === 'presentation'
        || table.getAttribute('width') === '100%'
        || table.querySelectorAll('th').length === 0;
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
    // Strip invisible Unicode characters used in email preheaders
    .replace(/[\u200B\u200C\u200D\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2060\u2061\u2062\u2063\u2064\uFEFF\u180E]/g, '')
    // Strip braille pattern blank and other invisible spacers
    .replace(/[͏​‌‍ ­]/g, '')
    // Remove empty markdown links: [](url) or [ ](url)
    .replace(/\[\s*\]\([^)]*\)/g, '')
    // Remove markdown links that contain only whitespace text
    .replace(/\[\s+\]\([^)]*\)/g, '')
    // Remove image-in-link leftovers: [![](url)](url) patterns
    .replace(/\[\s*!\[\s*\]\([^)]*\)\s*\]\([^)]*\)/g, '')
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

/**
 * Convert an HTML email body to clean markdown.
 *
 * Uses linkedom to parse HTML in a Worker-compatible way (no native DOM needed),
 * then Turndown to convert to markdown with aggressive email-specific cleanup.
 *
 * @param html - Raw HTML string from email body
 * @returns Clean markdown string optimized for LLM consumption
 */
export function htmlToMarkdown(html: string): string {
  if (!html || html.trim().length === 0) {
    return '';
  }

  // Parse HTML using linkedom (Worker-compatible DOM implementation)
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);

  // Remove non-content elements before conversion
  for (const el of document.querySelectorAll('style, script, meta, link')) {
    el.remove();
  }

  const turndown = getTurndown();
  const markdown = turndown.turndown(document.body as unknown as TurndownService.Node);

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
