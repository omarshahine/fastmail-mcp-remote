/**
 * Shared helpers for CLI command modules.
 *
 * Extracted from email.ts, calendar.ts, contacts.ts, and memo.ts
 * to eliminate duplication.
 */

/** Output JSON (optionally filtered by --fields) or formatted text. */
export function output(data: any, formatter: (d: any) => string, json: boolean, fields?: string) {
  if (json) {
    const filtered = fields ? filterFields(data, fields) : data;
    console.log(JSON.stringify(filtered, null, 2));
  } else {
    console.log(formatter(data));
  }
}

/** Filter JSON output to only the requested fields (comma-separated). */
export function filterFields(data: any, fields: string): any {
  const keys = new Set(fields.split(",").map((f) => f.trim()));
  if (Array.isArray(data)) return data.map((item) => pick(item, keys));
  if (data && typeof data === "object") return pick(data, keys);
  return data;
}

export function pick(obj: Record<string, any>, keys: Set<string>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of keys) {
    if (key in obj) result[key] = obj[key];
  }
  return result;
}

/** Format a dry-run preview for a mutation command. */
export function dryRunOutput(toolName: string, args: Record<string, unknown>): void {
  console.log(`[dry-run] Would call: ${toolName}`);
  console.log(JSON.stringify(args, null, 2));
}
