export type EolStyle = 'lf' | 'crlf';

/** Heuristic binary detection: NUL byte within the first 8 KiB. */
export function detectBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export function detectEol(text: string): EolStyle {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? 'crlf' : 'lf';
}

export function normalizeToEol(text: string, eol: EolStyle): string {
  const lines = text.split(/\r\n|\r|\n/);
  return lines.join(eol === 'lf' ? '\n' : '\r\n');
}
