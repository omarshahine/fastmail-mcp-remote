/**
 * Input hardening: reject hallucinated / malformed agent inputs.
 *
 * Agents are untrusted operators — they routinely hallucinate control characters,
 * path traversal sequences, embedded query params, and double-encoded strings.
 *
 * Ref: https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/
 */

import { EXIT, fatal } from "./exit-codes.js";

// ── Control character rejection ────────────────────────────

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function rejectControlChars(value: string, label: string): void {
  if (CONTROL_CHAR_RE.test(value)) {
    fatal(
      `Invalid ${label}: contains control characters. ` +
        `Ensure the value is plain text without invisible characters.`,
      EXIT.INPUT,
    );
  }
}

// ── Resource ID validation ─────────────────────────────────

/** Characters that should never appear in a Fastmail/JMAP resource ID. */
const BAD_ID_RE = /[?#%\/\\<>{}|^~`\[\]]/;

function validateResourceId(id: string, label: string): void {
  rejectControlChars(id, label);
  if (BAD_ID_RE.test(id)) {
    fatal(
      `Invalid ${label}: "${id}" contains unexpected characters (?, #, %, /, \\, etc.). ` +
        `Resource IDs should be opaque alphanumeric strings from previous command output.`,
      EXIT.INPUT,
    );
  }
  if (id.length > 255) {
    fatal(`Invalid ${label}: too long (${id.length} chars, max 255).`, EXIT.INPUT);
  }
}

// ── Email address basic validation ─────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(addr: string, label: string): void {
  rejectControlChars(addr, label);
  if (!EMAIL_RE.test(addr)) {
    fatal(
      `Invalid ${label}: "${addr}" doesn't look like an email address.`,
      EXIT.INPUT,
    );
  }
}

// ── Date validation ────────────────────────────────────────

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function validateDate(value: string, label: string): void {
  rejectControlChars(value, label);
  if (!ISO8601_RE.test(value) || isNaN(new Date(value).getTime())) {
    fatal(
      `Invalid ${label}: "${value}" is not a valid ISO 8601 date.`,
      EXIT.INPUT,
    );
  }
}

// ── Free-text validation (bodies, subjects) ────────────────

function validateText(value: string, label: string): void {
  rejectControlChars(value, label);
}

// ── Double-encoding detection ──────────────────────────────

const DOUBLE_ENCODED_RE = /%25[0-9A-Fa-f]{2}/;

function rejectDoubleEncoding(value: string, label: string): void {
  if (DOUBLE_ENCODED_RE.test(value)) {
    fatal(
      `Invalid ${label}: appears to be double-URL-encoded. ` +
        `Pass plain text values — the CLI handles encoding.`,
      EXIT.INPUT,
    );
  }
}

// ── Public API ─────────────────────────────────────────────

/** Validate one or more resource IDs (email IDs, mailbox IDs, thread IDs, etc.). */
export function validateIds(ids: string | string[], label = "ID"): void {
  const list = Array.isArray(ids) ? ids : [ids];
  for (const id of list) {
    validateResourceId(id, label);
    rejectDoubleEncoding(id, label);
  }
}

/** Validate email address(es). */
export function validateEmails(addrs: string | string[], label = "email address"): void {
  const list = Array.isArray(addrs) ? addrs : [addrs];
  for (const addr of list) {
    validateEmail(addr, label);
  }
}

/** Validate a date string. */
export function validateDateArg(value: string, label = "date"): void {
  validateDate(value, label);
}

/** Validate free-text input (subject, body, description). */
export function validateTextArg(value: string, label = "text"): void {
  validateText(value, label);
  rejectDoubleEncoding(value, label);
}

/** Validate a search query. */
export function validateQuery(value: string, label = "query"): void {
  rejectControlChars(value, label);
  rejectDoubleEncoding(value, label);
}

/** Validate a positive integer (limit, etc.). */
export function validatePositiveInt(value: string, label = "number"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10000) {
    fatal(`Invalid ${label}: "${value}" — must be a positive integer (1-10000).`, EXIT.INPUT);
  }
  return n;
}
