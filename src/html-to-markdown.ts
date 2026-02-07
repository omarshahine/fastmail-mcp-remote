import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';

/**
 * Converts HTML email bodies to clean markdown optimized for LLM consumption.
 *
 * Email HTML is notoriously bloated — marketing emails use table-based layouts,
 * tracking pixels, spacer GIFs, and inline styles that can balloon a simple
 * message to 20-50KB+. This module strips all that noise and returns just
 * the semantic content as markdown.
 */

// DOM node interface for linkedom elements (Workers don't have global HTMLElement)
interface DomNode {
  nodeName: string;
  nodeType: number;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<DomNode>;
  closest(selector: string): DomNode | null;
}

// Regex for tracking pixel URL paths — only matches path segments, not domains.
// Avoids false positives on legitimate image CDNs (e.g., Mailchimp content images).
const TRACKING_PATH_PATTERN = /\/(track|pixel|beacon|wf\/open|o\/open|e\/o|trk|cl)[\/?]/i;

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  // Strip tracking pixels: 1x1 images or images with tracking-specific URL paths
  service.addRule('trackingPixels', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'IMG') return false;
      const width = node.getAttribute('width');
      const height = node.getAttribute('height');
      // 1x1 pixel images are almost always trackers
      if (width === '1' && height === '1') return true;
      if (width === '0' || height === '0') return true;
      // Check URL path for common tracking pixel patterns
      const src = node.getAttribute('src') || '';
      return TRACKING_PATH_PATTERN.test(src);
    }) as TurndownService.FilterFunction,
    replacement: () => '',
  });

  // Strip invisible spacer images (transparent GIFs, blank spacers)
  service.addRule('spacerImages', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'IMG') return false;
      const src = (node.getAttribute('src') || '').toLowerCase();
      const alt = node.getAttribute('alt') || '';
      // Spacer GIFs with no alt text
      if (/spacer|blank|transparent|shim/i.test(src) && alt === '') return true;
      // Data URI transparent images
      if (src.startsWith('data:image/gif') && alt === '') return true;
      return false;
    }) as TurndownService.FilterFunction,
    replacement: () => '',
  });

  // Flatten layout tables: tables used for email layout (not data tables)
  service.addRule('layoutTables', {
    filter: ((node: DomNode) => {
      if (node.nodeName !== 'TABLE') return false;
      // Explicit presentation role = layout table
      if (node.getAttribute('role') === 'presentation') return true;
      // Full-width tables are almost always layout
      if (node.getAttribute('width') === '100%') return true;
      // No <th> elements = likely layout, not data
      if (node.querySelectorAll('th').length === 0) return true;
      return false;
    }) as TurndownService.FilterFunction,
    replacement: (content: string) => content + '\n\n',
  });

  // Also flatten layout table rows and cells to just pass through content
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

  // Strip style tags entirely
  service.remove(['style'] as unknown as TurndownService.Filter);

  // Strip script tags entirely
  service.remove(['script'] as unknown as TurndownService.Filter);

  // Strip HTML comments (handled by linkedom parsing, but just in case)
  service.addRule('comments', {
    filter: ((node: DomNode) => node.nodeType === 8) as TurndownService.FilterFunction, // COMMENT_NODE
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
 * Clean up the markdown output: collapse excessive whitespace,
 * remove trailing spaces, normalize line endings.
 */
function cleanMarkdown(md: string): string {
  return md
    // Collapse 3+ newlines to 2 (preserve paragraph breaks)
    .replace(/\n{3,}/g, '\n\n')
    // Remove lines that are only whitespace
    .replace(/^[ \t]+$/gm, '')
    // Remove trailing whitespace from lines
    .replace(/[ \t]+$/gm, '')
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
 * then Turndown to convert to markdown with email-specific cleanup rules.
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

  // Remove <style> and <script> elements before conversion
  for (const el of document.querySelectorAll('style, script')) {
    el.remove();
  }

  const turndown = getTurndown();
  const markdown = turndown.turndown(document.body as unknown as TurndownService.Node);

  return cleanMarkdown(markdown);
}

/**
 * Format an email as LLM-friendly structured text.
 *
 * Returns a markdown document with:
 * - Header section (Subject, From, To, CC, Date)
 * - Body as markdown-converted content
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
