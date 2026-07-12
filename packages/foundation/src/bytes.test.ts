import { describe, expect, it } from 'vitest';
import { detectBinary, detectEol, normalizeToEol } from './bytes.js';

describe('byte and text detection', () => {
  it('detects binary content by NUL bytes', () => {
    expect(detectBinary(new Uint8Array([0x50, 0x4b, 0x00, 0x01]))).toBe(true);
    expect(detectBinary(new TextEncoder().encode('plain text file'))).toBe(false);
  });

  it('detects dominant EOL style', () => {
    expect(detectEol('a\nb\nc')).toBe('lf');
    expect(detectEol('a\r\nb\r\nc')).toBe('crlf');
    expect(detectEol('no newline')).toBe('lf');
  });

  it('normalizes text to a target EOL without data loss', () => {
    expect(normalizeToEol('a\r\nb\nc', 'lf')).toBe('a\nb\nc');
    expect(normalizeToEol('a\nb', 'crlf')).toBe('a\r\nb');
  });
});
