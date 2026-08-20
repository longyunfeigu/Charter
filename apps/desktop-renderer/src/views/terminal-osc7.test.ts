import { describe, expect, it } from 'vitest';
import { parseOsc7Cwd } from './terminal-osc7.js';

describe('parseOsc7Cwd (ADR-0059)', () => {
  it('parses the canonical file://host/path emission', () => {
    expect(parseOsc7Cwd('file://gpu-node/root/datasets')).toBe('/root/datasets');
  });

  it('parses an empty-authority file:///path emission', () => {
    expect(parseOsc7Cwd('file:///srv/data')).toBe('/srv/data');
  });

  it('percent-decodes encoded emitters (iTerm2/VTE style)', () => {
    expect(parseOsc7Cwd('file://host/srv/my%20data')).toBe('/srv/my data');
  });

  it('keeps raw paths whose % is not valid encoding', () => {
    expect(parseOsc7Cwd('file://host/srv/100%_done')).toBe('/srv/100%_done');
  });

  it('keeps root and trims trailing slashes elsewhere', () => {
    expect(parseOsc7Cwd('file://host/')).toBe('/');
    expect(parseOsc7Cwd('file://host/srv/x/')).toBe('/srv/x');
  });

  it('rejects everything that is not an absolute file URI', () => {
    expect(parseOsc7Cwd('')).toBeNull();
    expect(parseOsc7Cwd('file:')).toBeNull();
    expect(parseOsc7Cwd('file://host')).toBeNull();
    expect(parseOsc7Cwd('http://host/x')).toBeNull();
    expect(parseOsc7Cwd('kitty-shell-cwd://host')).toBeNull();
  });

  it('rejects reports carrying control bytes', () => {
    expect(parseOsc7Cwd('file://host/srv/\u0007evil')).toBeNull();
    expect(parseOsc7Cwd('file://host/srv/a\u001b[31m')).toBeNull();
  });
});
