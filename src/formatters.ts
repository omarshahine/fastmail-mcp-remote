/**
 * Shared compact text formatters for token-efficient MCP responses.
 *
 * These are extracted from cli/formatters.ts so both the CLI and MCP server
 * can produce the same compact output. Each formatter takes parsed JMAP data
 * and emits scannable text optimized for LLM token efficiency (5-7x smaller
 * than pretty-printed JSON).
 */

// ── Helpers ──────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day} ${hours}:${mins}`;
}

function formatAddr(addr: { name?: string; email: string }): string {
  if (addr.name) return `${addr.name} <${addr.email}>`;
  return addr.email;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Email List ───────────────────────────────────────────────

export function formatEmailList(
  emails: any[],
  title?: string,
): string {
  if (!emails || emails.length === 0) return "No emails found.";

  const lines: string[] = [];

  if (title) {
    lines.push(`# ${title} (${emails.length})`);
    lines.push("");
  }

  for (const e of emails) {
    const id = e.id || "?";
    const date = e.receivedAt ? formatDate(e.receivedAt) : "           ";
    const from = typeof e.from === "string" ? e.from : e.from?.[0] ? formatAddr(e.from[0]) : "Unknown";
    const subject = e.subject || "(no subject)";
    const preview = e.preview ? truncate(e.preview, 80) : "";

    // Status indicators from keywords
    const keywords = e.keywords || {};
    const unread = !keywords.$seen ? "*" : " ";
    const flagged = keywords.$flagged ? "!" : "";
    const att = e.hasAttachment ? " [att]" : "";

    lines.push(
      `${id}  ${date}  ${unread}${flagged}${from}${att}`,
    );
    lines.push(`  ${subject} \u2014 ${preview}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── Mailboxes ────────────────────────────────────────────────

export function formatMailboxes(mailboxes: any[]): string {
  if (!mailboxes?.length) return "No mailboxes found.";

  const lines: string[] = ["# Mailboxes", ""];

  const sorted = [...mailboxes].sort((a, b) => {
    if (a.role && !b.role) return -1;
    if (!a.role && b.role) return 1;
    return (a.name || "").localeCompare(b.name || "");
  });

  for (const mb of sorted) {
    const role = mb.role ? ` (${mb.role})` : "";
    const total = mb.totalEmails ?? 0;
    const unread = mb.unreadEmails ?? 0;
    const unreadStr = unread > 0 ? `  unread: ${unread}` : "";
    lines.push(`${mb.id}  ${mb.name}${role}  ${total} emails${unreadStr}`);
  }

  return lines.join("\n");
}

// ── Mailbox Stats ────────────────────────────────────────────

export function formatMailboxStats(stats: any): string {
  if (Array.isArray(stats)) {
    const lines: string[] = ["# Mailbox Statistics", ""];
    for (const mb of stats) {
      const unread = mb.unreadEmails > 0 ? `  unread: ${mb.unreadEmails}` : "";
      lines.push(`${mb.name} (${mb.role || "custom"})  ${mb.totalEmails} emails${unread}`);
    }
    return lines.join("\n");
  }
  return [
    `# ${stats.name}${stats.role ? ` (${stats.role})` : ""}`,
    "",
    `Total emails: ${stats.totalEmails ?? 0}`,
    `Unread: ${stats.unreadEmails ?? 0}`,
    `Threads: ${stats.totalThreads ?? 0}`,
    `Unread threads: ${stats.unreadThreads ?? 0}`,
  ].join("\n");
}

// ── Account Summary ──────────────────────────────────────────

export function formatAccountSummary(summary: any): string {
  const lines: string[] = [
    "# Account Summary",
    "",
    `Mailboxes: ${summary.mailboxCount}`,
    `Identities: ${summary.identityCount}`,
    `Total emails: ${summary.totalEmails}`,
    `Unread: ${summary.unreadEmails}`,
    "",
    "Mailboxes:",
  ];

  if (summary.mailboxes) {
    for (const mb of summary.mailboxes) {
      const unread = mb.unreadEmails > 0 ? `  unread: ${mb.unreadEmails}` : "";
      lines.push(`  ${mb.name}${mb.role ? ` (${mb.role})` : ""}  ${mb.totalEmails}${unread}`);
    }
  }

  return lines.join("\n");
}

// ── Contacts ─────────────────────────────────────────────────

export function formatContacts(contacts: any[]): string {
  if (!contacts?.length) return "No contacts found.";

  const lines: string[] = [`# Contacts (${contacts.length})`, ""];

  for (const c of contacts) {
    const name = c.name
      || [c.prefix, c.firstName, c.lastName].filter(Boolean).join(" ")
      || "Unnamed";
    lines.push(`${c.id}  ${name}`);

    const emails =
      c.emails?.map((e: any) => e.value || e.email).filter(Boolean) || [];
    const phones =
      c.phones?.map((p: any) => p.value || p.phone).filter(Boolean) || [];
    const details = [...emails, ...phones].join(" | ");
    if (details) lines.push(`  ${details}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatContact(contact: any): string {
  if (!contact) return "Contact not found.";

  const lines: string[] = [];
  const name = contact.name || [contact.prefix, contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unnamed";
  lines.push(`# ${name}`);
  if (contact.id) lines.push(`ID: ${contact.id}`);
  lines.push("");

  if (contact.company) lines.push(`Company: ${contact.company}`);
  if (contact.department) lines.push(`Department: ${contact.department}`);
  if (contact.jobTitle) lines.push(`Title: ${contact.jobTitle}`);

  if (contact.emails?.length) {
    lines.push("");
    lines.push("Emails:");
    for (const e of contact.emails) {
      const label = e.label || e.type || "";
      lines.push(`  ${label ? label + ": " : ""}${e.value || e.email}`);
    }
  }

  if (contact.phones?.length) {
    lines.push("");
    lines.push("Phones:");
    for (const p of contact.phones) {
      const label = p.label || p.type || "";
      lines.push(`  ${label ? label + ": " : ""}${p.value || p.phone}`);
    }
  }

  if (contact.addresses?.length) {
    lines.push("");
    lines.push("Addresses:");
    for (const a of contact.addresses) {
      const parts = [a.street, a.city, a.state, a.postcode, a.country].filter(Boolean);
      const label = a.label || a.type || "";
      lines.push(`  ${label ? label + ": " : ""}${parts.join(", ")}`);
    }
  }

  if (contact.notes) {
    lines.push("");
    lines.push(`Notes: ${contact.notes}`);
  }

  return lines.join("\n");
}

// ── Calendar ─────────────────────────────────────────────────

export function formatCalendars(calendars: any[]): string {
  if (!calendars?.length) return "No calendars found.";

  const lines: string[] = ["# Calendars", ""];
  for (const cal of calendars) {
    lines.push(`${cal.id}  ${cal.name}${cal.isDefault ? " (default)" : ""}`);
  }
  return lines.join("\n");
}

export function formatEvents(events: any[]): string {
  if (!events?.length) return "No events found.";

  const lines: string[] = [`# Events (${events.length})`, ""];

  for (const e of events) {
    const start = e.start ? formatDate(e.start) : "?";
    let timeRange = start;
    if (e.start && e.duration) {
      timeRange = `${start}  (${e.duration})`;
    } else if (e.end) {
      const endTime = formatDate(e.end);
      if (endTime.slice(0, 10) === start.slice(0, 10)) {
        timeRange = `${start}-${endTime.slice(11)}`;
      } else {
        timeRange = `${start} to ${endTime}`;
      }
    }

    const title = e.title || "(no title)";
    lines.push(`${e.id}  ${timeRange}  ${title}`);

    const details: string[] = [];
    if (e.location) details.push(e.location);
    if (e.calendarName || e.calendarId) details.push(`Calendar: ${e.calendarName || e.calendarId}`);
    if (details.length) lines.push(`  ${details.join(" | ")}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── Identities ───────────────────────────────────────────────

export function formatIdentities(identities: any[]): string {
  if (!identities?.length) return "No identities found.";

  const lines: string[] = ["# Identities", ""];
  for (const id of identities) {
    const name = id.name || "";
    const email = id.email || "";
    const isDefault = id.mayDelete === false ? " (primary)" : "";
    lines.push(`${name ? name + " " : ""}<${email}>${isDefault}`);
  }
  return lines.join("\n");
}

// ── Memos ────────────────────────────────────────────────────

export function formatMemo(memo: any): string {
  if (!memo) return "No memo found for this email.";
  if (typeof memo === "string") return memo;

  const lines: string[] = [];
  if (memo.subject) lines.push(`# Memo: ${memo.subject}`);
  if (memo.memoId) lines.push(`Memo ID: ${memo.memoId}`);
  if (memo.receivedAt) lines.push(`Created: ${formatDate(memo.receivedAt)}`);
  lines.push("");

  const bodyValues = memo.bodyValues as Record<string, { value: string }> | undefined;
  const textPartId = memo.textBody?.[0]?.partId;
  const text = textPartId && bodyValues?.[textPartId]?.value;
  if (text) {
    lines.push(text);
  } else if (memo.preview) {
    lines.push(memo.preview);
  } else if (memo.text) {
    lines.push(memo.text);
  }

  return lines.join("\n");
}

// ── Attachments ──────────────────────────────────────────────

export function formatAttachments(attachments: any[]): string {
  if (!attachments?.length) return "No attachments.";

  const lines: string[] = [`# Attachments (${attachments.length})`, ""];
  for (const att of attachments) {
    const size = att.size ? ` (${formatFileSize(att.size)})` : "";
    const type = att.type || att.mimeType || "";
    lines.push(`${att.blobId || att.id || "?"}  ${att.name || "unnamed"}  ${type}${size}`);
  }
  return lines.join("\n");
}

// ── Inbox Updates ────────────────────────────────────────────

export function formatInboxUpdates(updates: any): string {
  const lines: string[] = [];

  if (updates.queryState) {
    lines.push(`State: ${updates.queryState}`);
  }

  if (updates.added?.length) {
    lines.push("");
    lines.push(`Added (${updates.added.length}):`);
    lines.push(formatEmailList(updates.added));
  }

  if (updates.removed?.length) {
    lines.push("");
    lines.push(`Removed: ${updates.removed.join(", ")}`);
  }

  if (!updates.added?.length && !updates.removed?.length) {
    lines.push("No changes since last check.");
  }

  return lines.join("\n");
}

// ── Address Flattening (Alt C) ──────────────────────────────

/**
 * Flatten nested address arrays into compact strings for list views.
 * Converts `[{name: "Alice", email: "a@b.com"}]` → `"Alice <a@b.com>"`
 * Reduces token overhead by ~10-15% on list responses.
 */
export function flattenEmailAddresses(email: Record<string, any>): Record<string, any> {
  const result = { ...email };
  for (const field of ["from", "to", "cc", "bcc", "replyTo"]) {
    if (Array.isArray(result[field])) {
      result[field] = result[field].map(formatAddr).join(", ");
    }
  }
  return result;
}

/**
 * Apply address flattening to an array of emails (for list views).
 */
export function flattenEmailList(emails: any[]): any[] {
  return emails.map(flattenEmailAddresses);
}
