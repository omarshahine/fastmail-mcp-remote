import { describe, it, expect } from 'vitest';
import {
  validateFilename,
  validateMimeType,
  decodeBase64,
} from '../src/jmap-client';

describe('validateFilename', () => {
  it('accepts valid filenames', () => {
    expect(() => validateFilename('report.pdf')).not.toThrow();
    expect(() => validateFilename('my-document.docx')).not.toThrow();
    expect(() => validateFilename('image_2024.png')).not.toThrow();
    expect(() => validateFilename('file with spaces.txt')).not.toThrow();
    expect(() => validateFilename('日本語ファイル.pdf')).not.toThrow();
  });

  it('rejects empty or missing filenames', () => {
    expect(() => validateFilename('')).toThrow('Filename is required');
    expect(() => validateFilename(null as any)).toThrow('Filename is required');
    expect(() => validateFilename(undefined as any)).toThrow('Filename is required');
  });

  it('rejects filenames that are too long', () => {
    const longName = 'a'.repeat(256);
    expect(() => validateFilename(longName)).toThrow('Filename must be between 1 and 255 characters');
  });

  it('rejects path traversal attempts', () => {
    expect(() => validateFilename('../etc/passwd')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('..\\windows\\system32')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('foo/../bar.txt')).toThrow('disallowed characters or patterns');
  });

  it('rejects absolute paths', () => {
    expect(() => validateFilename('/etc/passwd')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('\\windows\\system32')).toThrow('disallowed characters or patterns');
  });

  it('rejects invalid filename characters', () => {
    expect(() => validateFilename('file<name>.txt')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('file>name.txt')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('file:name.txt')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('file"name.txt')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('file|name.txt')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('file?name.txt')).toThrow('disallowed characters or patterns');
    expect(() => validateFilename('file*name.txt')).toThrow('disallowed characters or patterns');
  });

  it('rejects filenames with null bytes', () => {
    expect(() => validateFilename('file\x00name.txt')).toThrow('disallowed characters or patterns');
  });
});

describe('validateMimeType', () => {
  it('accepts valid MIME types', () => {
    expect(() => validateMimeType('application/pdf')).not.toThrow();
    expect(() => validateMimeType('image/png')).not.toThrow();
    expect(() => validateMimeType('image/jpeg')).not.toThrow();
    expect(() => validateMimeType('text/plain')).not.toThrow();
    expect(() => validateMimeType('text/html')).not.toThrow();
    expect(() => validateMimeType('application/octet-stream')).not.toThrow();
    expect(() => validateMimeType('application/vnd.ms-excel')).not.toThrow();
    expect(() => validateMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).not.toThrow();
  });

  it('rejects empty or missing MIME types', () => {
    expect(() => validateMimeType('')).toThrow('MIME type is required');
    expect(() => validateMimeType(null as any)).toThrow('MIME type is required');
    expect(() => validateMimeType(undefined as any)).toThrow('MIME type is required');
  });

  it('rejects invalid MIME type formats', () => {
    expect(() => validateMimeType('pdf')).toThrow('Invalid MIME type format');
    expect(() => validateMimeType('application')).toThrow('Invalid MIME type format');
    expect(() => validateMimeType('application/')).toThrow('Invalid MIME type format');
    expect(() => validateMimeType('/pdf')).toThrow('Invalid MIME type format');
    expect(() => validateMimeType('application//pdf')).toThrow('Invalid MIME type format');
    expect(() => validateMimeType('application/pdf/extra')).toThrow('Invalid MIME type format');
  });

  it('rejects MIME types with invalid characters', () => {
    expect(() => validateMimeType('application/pdf;charset=utf-8')).toThrow('Invalid MIME type format');
    expect(() => validateMimeType('application/pdf ')).toThrow('Invalid MIME type format');
    expect(() => validateMimeType(' application/pdf')).toThrow('Invalid MIME type format');
  });
});

describe('decodeBase64', () => {
  it('decodes valid base64 content', () => {
    // "Hello, World!" in base64
    const base64 = 'SGVsbG8sIFdvcmxkIQ==';
    const result = decodeBase64(base64);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(13);

    // Convert back to string to verify
    const decoded = String.fromCharCode(...result);
    expect(decoded).toBe('Hello, World!');
  });

  it('decodes base64 without padding', () => {
    // "Hi" in base64 (no padding needed)
    const base64 = 'SGk';
    const result = decodeBase64(base64);
    const decoded = String.fromCharCode(...result);
    expect(decoded).toBe('Hi');
  });

  it('decodes empty base64 string', () => {
    // Empty string should throw since we require content
    expect(() => decodeBase64('')).toThrow('Content is required');
  });

  it('rejects null or undefined content', () => {
    expect(() => decodeBase64(null as any)).toThrow('Content is required');
    expect(() => decodeBase64(undefined as any)).toThrow('Content is required');
  });

  it('rejects invalid base64 content', () => {
    expect(() => decodeBase64('not valid base64!!!')).toThrow('Invalid base64 content');
    expect(() => decodeBase64('SGVsbG8===')).toThrow('Invalid base64 content'); // Wrong padding
  });

  it('handles binary data correctly', () => {
    // Binary data: bytes 0x00, 0x01, 0x02, 0xFF
    const base64 = 'AAEC/w==';
    const result = decodeBase64(base64);

    expect(result.length).toBe(4);
    expect(result[0]).toBe(0x00);
    expect(result[1]).toBe(0x01);
    expect(result[2]).toBe(0x02);
    expect(result[3]).toBe(0xFF);
  });

  it('handles large content', () => {
    // Create a large base64 string (about 1MB decoded)
    const size = 1024 * 1024;
    const binaryData = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      binaryData[i] = i % 256;
    }

    // Convert to base64
    let binaryString = '';
    for (let i = 0; i < binaryData.length; i++) {
      binaryString += String.fromCharCode(binaryData[i]);
    }
    const base64 = btoa(binaryString);

    // Decode and verify
    const result = decodeBase64(base64);
    expect(result.length).toBe(size);
    expect(result[0]).toBe(0);
    expect(result[255]).toBe(255);
    expect(result[256]).toBe(0);
  });
});

describe('attachment validation integration', () => {
  it('validates complete attachment input', () => {
    // Test that all validations work together
    const validAttachment = {
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      content: 'SGVsbG8sIFdvcmxkIQ==', // "Hello, World!"
    };

    expect(() => validateFilename(validAttachment.filename)).not.toThrow();
    expect(() => validateMimeType(validAttachment.mimeType)).not.toThrow();
    expect(() => decodeBase64(validAttachment.content)).not.toThrow();
  });

  it('catches invalid filename in attachment', () => {
    const invalidAttachment = {
      filename: '../../../etc/passwd',
      mimeType: 'application/pdf',
      content: 'SGVsbG8sIFdvcmxkIQ==',
    };

    expect(() => validateFilename(invalidAttachment.filename)).toThrow();
  });

  it('catches invalid MIME type in attachment', () => {
    const invalidAttachment = {
      filename: 'document.pdf',
      mimeType: 'not-a-mime-type',
      content: 'SGVsbG8sIFdvcmxkIQ==',
    };

    expect(() => validateMimeType(invalidAttachment.mimeType)).toThrow();
  });

  it('catches invalid base64 in attachment', () => {
    const invalidAttachment = {
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      content: 'not valid base64!!!',
    };

    expect(() => decodeBase64(invalidAttachment.content)).toThrow();
  });
});
