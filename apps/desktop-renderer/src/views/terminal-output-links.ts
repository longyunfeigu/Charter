import { detectFileLinks, detectWideCandidates } from './terminal-file-links.js';

const ESC = '\u001b';
const BEL = '\u0007';
const C1_CSI = '\u009b';
const C1_DCS = '\u0090';
const C1_OSC = '\u009d';
const C1_PM = '\u009e';
const C1_APC = '\u009f';
const C1_SOS = '\u0098';
const C1_ST = '\u009c';

const BLUE_FOREGROUND = `${ESC}[34m`;
const DEFAULT_FOREGROUND = `${ESC}[39m`;
const MAX_UNDERLINED_CANDIDATE = 4096;

type ParserMode = 'ground' | 'escape' | 'csi' | 'osc' | 'osc-escape' | 'string' | 'string-escape';

function isFinalByte(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function foregroundFromSgr(body: string, current: string): string {
  const params = body.split(';');
  let foreground = current;

  for (let index = 0; index < params.length; index += 1) {
    const token = params[index] ?? '';
    const colon = token.split(':');
    const value = Number.parseInt(colon[0] || '0', 10);

    if (value === 0 || value === 39) {
      foreground = DEFAULT_FOREGROUND;
      continue;
    }
    if ((value >= 30 && value <= 37) || (value >= 90 && value <= 97)) {
      foreground = `${ESC}[${value}m`;
      continue;
    }
    if (value !== 38) continue;

    if (colon.length > 1) {
      const mode = Number.parseInt(colon[1] ?? '', 10);
      if ((mode === 5 && colon.length >= 3) || (mode === 2 && colon.length >= 5)) {
        foreground = `${ESC}[${token}m`;
      }
      continue;
    }

    const mode = Number.parseInt(params[index + 1] ?? '', 10);
    const colorLength = mode === 5 ? 3 : mode === 2 ? (params[index + 2] === '' ? 6 : 5) : 0;
    if (colorLength > 0 && index + colorLength <= params.length) {
      foreground = `${ESC}[${params.slice(index, index + colorLength).join(';')}m`;
      index += colorLength - 1;
    }
  }

  return foreground;
}

function underlineFromSgr(body: string, current: boolean): boolean {
  let underlined = current;
  for (const token of body.split(';')) {
    const colon = token.split(':');
    const value = Number.parseInt(colon[0] || '0', 10);
    if (value === 0 || value === 24 || (value === 4 && colon[1] === '0')) underlined = false;
    else if (value === 4 || value === 21) underlined = true;
  }
  return underlined;
}

function isExactFilePath(text: string): boolean {
  const matches = detectFileLinks(text);
  if (matches.some((match) => match.start === 0 && match.end === text.length)) return true;
  // Underline is a strong boundary signal from agent TUIs, so absolute paths
  // may safely use an unverified wide candidate that spans the whole label.
  return detectWideCandidates(text, matches).some((group) =>
    group.some((candidate) => candidate.start === 0 && candidate.end === text.length),
  );
}

function oscBody(sequence: string): string {
  const start = sequence.startsWith(`${ESC}]`) ? 2 : 1;
  let end = sequence.length;
  if (sequence.endsWith(`${ESC}\\`)) end -= 2;
  else end -= 1;
  return sequence.slice(start, end);
}

/**
 * xterm preserves guest colors for OSC 8 links, while Claude Code renders its
 * plain file links as underlined paths. Both are clickable in Charter but have
 * no color affordance. This streaming VT pass makes only those file paths blue
 * and restores the exact foreground used by surrounding terminal output.
 */
export class TerminalFileLinkColorizer {
  private mode: ParserMode = 'ground';
  private sequence = '';
  private fileLinkActive = false;
  private foreground = DEFAULT_FOREGROUND;
  private savedForeground = DEFAULT_FOREGROUND;
  private underlineActive = false;
  private underlineCaptureSuppressed = false;
  private underlinedRaw = '';
  private underlinedBlueRaw = '';
  private underlinedText = '';

  reset(): void {
    this.mode = 'ground';
    this.sequence = '';
    this.fileLinkActive = false;
    this.foreground = DEFAULT_FOREGROUND;
    this.savedForeground = DEFAULT_FOREGROUND;
    this.underlineActive = false;
    this.underlineCaptureSuppressed = false;
    this.underlinedRaw = '';
    this.underlinedBlueRaw = '';
    this.underlinedText = '';
  }

  write(chunk: string): string {
    let output = '';

    for (const char of chunk) {
      if (this.mode === 'string') {
        output += char;
        if (char === C1_ST || char === '\u0018' || char === '\u001a') this.mode = 'ground';
        else if (char === ESC) this.mode = 'string-escape';
        continue;
      }

      if (this.mode === 'string-escape') {
        output += char;
        if (char === '\\' || char === C1_ST || char === BEL) this.mode = 'ground';
        else if (char !== ESC) this.mode = 'string';
        continue;
      }

      if (this.mode === 'escape') {
        this.sequence += char;
        if (char === '[') {
          this.mode = 'csi';
          continue;
        }
        if (char === ']') {
          this.mode = 'osc';
          continue;
        }
        if (char === 'P' || char === 'X' || char === '^' || char === '_') {
          output += this.flushUnderlinedCandidate() + this.sequence;
          this.sequence = '';
          this.mode = 'string';
          continue;
        }
        output += this.finishEscape(char);
        continue;
      }

      if (this.mode === 'csi') {
        this.sequence += char;
        if (char === '\u0018' || char === '\u001a') {
          output += this.flushSequence();
          continue;
        }
        if (isFinalByte(char)) output += this.finishCsi(char);
        continue;
      }

      if (this.mode === 'osc') {
        this.sequence += char;
        if (char === BEL || char === C1_ST) output += this.finishOsc();
        else if (char === ESC) this.mode = 'osc-escape';
        else if (char === '\u0018' || char === '\u001a') output += this.flushSequence();
        continue;
      }

      if (this.mode === 'osc-escape') {
        this.sequence += char;
        if (char === '\\' || char === BEL || char === C1_ST) output += this.finishOsc();
        else if (char !== ESC) this.mode = 'osc';
        continue;
      }

      if (char === ESC) {
        this.mode = 'escape';
        this.sequence = char;
      } else if (char === C1_CSI) {
        this.mode = 'csi';
        this.sequence = char;
      } else if (char === C1_OSC) {
        this.mode = 'osc';
        this.sequence = char;
      } else if ([C1_DCS, C1_PM, C1_APC, C1_SOS].includes(char)) {
        output += this.flushUnderlinedCandidate() + char;
        this.mode = 'string';
      } else if (this.underlineActive && this.isPrintable(char)) {
        output += this.captureUnderlined(char);
      } else {
        output += this.flushUnderlinedCandidate() + char;
      }
    }

    return output;
  }

  private finishEscape(final: string): string {
    const sequence = this.sequence;
    const pending = this.flushUnderlinedCandidate();
    if (final === '7') this.savedForeground = this.foreground;
    else if (final === '8') this.foreground = this.savedForeground;
    else if (final === 'c') {
      this.foreground = DEFAULT_FOREGROUND;
      this.savedForeground = DEFAULT_FOREGROUND;
      this.fileLinkActive = false;
      this.underlineActive = false;
      this.underlineCaptureSuppressed = false;
    }
    this.sequence = '';
    this.mode = 'ground';
    return pending + sequence;
  }

  private finishCsi(final: string): string {
    const sequence = this.sequence;
    const introLength = sequence.startsWith(`${ESC}[`) ? 2 : 1;
    const body = sequence.slice(introLength, -1);
    const wasUnderlined = this.underlineActive;
    const previousForeground = this.foreground;

    if (final === 'm') {
      this.foreground = foregroundFromSgr(body, this.foreground);
      this.underlineActive = underlineFromSgr(body, this.underlineActive);
      if (wasUnderlined && this.underlineActive && this.underlinedText) {
        this.underlinedRaw += sequence + (this.fileLinkActive ? BLUE_FOREGROUND : '');
        this.underlinedBlueRaw += sequence + BLUE_FOREGROUND;
        this.sequence = '';
        this.mode = 'ground';
        return '';
      }
      if (!this.underlineActive) this.underlineCaptureSuppressed = false;
    } else if (final === 's') this.savedForeground = this.foreground;
    else if (final === 'u') this.foreground = this.savedForeground;
    else if (final === 'p' && body.endsWith('!')) {
      this.foreground = DEFAULT_FOREGROUND;
      this.savedForeground = DEFAULT_FOREGROUND;
      this.fileLinkActive = false;
      this.underlineActive = false;
      this.underlineCaptureSuppressed = false;
    }

    const pending = this.flushUnderlinedCandidate(previousForeground);
    this.sequence = '';
    this.mode = 'ground';
    return pending + sequence + (final === 'm' && this.fileLinkActive ? BLUE_FOREGROUND : '');
  }

  private finishOsc(): string {
    const sequence = this.sequence;
    const body = oscBody(sequence);
    const pending = this.flushUnderlinedCandidate();
    this.sequence = '';
    this.mode = 'ground';

    if (!body.startsWith('8;')) return pending + sequence;
    const payload = body.slice(2);
    const separator = payload.indexOf(';');
    if (separator < 0) return pending + sequence;
    const params = payload.slice(0, separator);
    const uri = payload.slice(separator + 1);
    const opensLink = uri.length > 0;
    const closesLink = !opensLink && params.trim().length === 0;
    if (!opensLink && !closesLink) return pending + sequence;

    const restore = this.fileLinkActive ? this.foreground : '';
    this.fileLinkActive = /^file:\/\//i.test(uri);
    return pending + restore + sequence + (this.fileLinkActive ? BLUE_FOREGROUND : '');
  }

  private flushSequence(): string {
    const sequence = this.sequence;
    const pending = this.flushUnderlinedCandidate();
    this.sequence = '';
    this.mode = 'ground';
    return pending + sequence;
  }

  private isPrintable(char: string): boolean {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
  }

  private captureUnderlined(char: string): string {
    if (this.underlineCaptureSuppressed) return char;
    this.underlinedRaw += char;
    this.underlinedBlueRaw += char;
    this.underlinedText += char;
    if (this.underlinedRaw.length <= MAX_UNDERLINED_CANDIDATE) return '';
    this.underlineCaptureSuppressed = true;
    return this.flushUnderlinedCandidate();
  }

  private flushUnderlinedCandidate(restore = this.foreground): string {
    if (!this.underlinedRaw) return '';
    const raw = this.underlinedRaw;
    const blueRaw = this.underlinedBlueRaw;
    const text = this.underlinedText;
    this.underlinedRaw = '';
    this.underlinedBlueRaw = '';
    this.underlinedText = '';
    if (!isExactFilePath(text)) return raw;
    return BLUE_FOREGROUND + blueRaw + (this.fileLinkActive ? BLUE_FOREGROUND : restore);
  }
}
