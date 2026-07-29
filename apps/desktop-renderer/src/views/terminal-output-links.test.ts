import { describe, expect, it } from 'vitest';
import { TerminalFileLinkColorizer } from './terminal-output-links.js';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;

function fileLink(label = 'src/app.ts', terminator = BEL): string {
  return `${ESC}]8;;file:///workspace/src/app.ts${terminator}` + label + `${ESC}]8;;${terminator}`;
}

describe('TerminalFileLinkColorizer', () => {
  it('makes the exact underlined path format from Claude Code blue', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const input =
      `${ESC}[38;2;44;122;57m●${ESC}[0m ${ESC}[1mUpdate${ESC}[0m(` +
      `${ESC}[4m/Users/dev/project/site.html${ESC}[0m) done`;

    expect(colorizer.write(input)).toBe(
      `${ESC}[38;2;44;122;57m●${ESC}[0m ${ESC}[1mUpdate${ESC}[0m(${ESC}[4m` +
        `${ESC}[34m/Users/dev/project/site.html${ESC}[39m${ESC}[0m) done`,
    );
  });

  it('recognizes a Claude path when its text and closing SGR arrive in later chunks', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const chunks = [`${ESC}[4m/Users/dev/`, 'project/site.html', `${ESC}[0m next`];

    expect(chunks.map((chunk) => colorizer.write(chunk)).join('')).toBe(
      `${ESC}[4m${ESC}[34m/Users/dev/project/site.html${ESC}[39m${ESC}[0m next`,
    );
  });

  it('does not recolor ordinary underlined prose or web URLs', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const input =
      `${ESC}[4mimportant note${ESC}[0m ` + `${ESC}[4mhttps://example.com/docs${ESC}[0m`;

    expect(colorizer.write(input)).toBe(input);
  });

  it('keeps an underlined path blue across inner SGR changes', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const input = `${ESC}[4msrc/${ESC}[1mapp.ts${ESC}[22m${ESC}[0m tail`;

    expect(colorizer.write(input)).toBe(
      `${ESC}[4m${ESC}[34msrc/${ESC}[1m${ESC}[34mapp.ts${ESC}[22m${ESC}[34m` +
        `${ESC}[39m${ESC}[0m tail`,
    );
  });

  it('colors a whole underlined path with spaces but not an underlined slash command', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const input =
      `${ESC}[4m/Users/dev/My Project/site.html${ESC}[0m ` + `${ESC}[4m/config${ESC}[0m`;

    expect(colorizer.write(input)).toBe(
      `${ESC}[4m${ESC}[34m/Users/dev/My Project/site.html${ESC}[39m${ESC}[0m ` +
        `${ESC}[4m/config${ESC}[0m`,
    );
  });

  it('makes a gray Claude-style file hyperlink blue and restores gray afterward', () => {
    const colorizer = new TerminalFileLinkColorizer();

    expect(colorizer.write(`${ESC}[90mUpdate(${fileLink()}) done`)).toBe(
      `${ESC}[90mUpdate(${ESC}]8;;file:///workspace/src/app.ts${BEL}${ESC}[34m` +
        `src/app.ts${ESC}[90m${ESC}]8;;${BEL}) done`,
    );
  });

  it('supports ST terminators and escape sequences split across PTY chunks', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const input = `${ESC}[38;2;110;110;110m${fileLink('src/app.ts', ST)} tail`;
    const chunks = [input.slice(0, 4), input.slice(4, 20), input.slice(20, 43), input.slice(43)];

    expect(chunks.map((chunk) => colorizer.write(chunk)).join('')).toBe(
      `${ESC}[38;2;110;110;110m${ESC}]8;;file:///workspace/src/app.ts${ST}${ESC}[34m` +
        `src/app.ts${ESC}[38;2;110;110;110m${ESC}]8;;${ST} tail`,
    );
  });

  it('leaves web hyperlinks and their foreground untouched', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const input =
      `${ESC}[36m${ESC}]8;;https://example.com${BEL}example${ESC}]8;;${BEL}` + `${ESC}[0m done`;

    expect(colorizer.write(input)).toBe(input);
  });

  it('keeps a file link blue across inner SGR while restoring its final foreground', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const input =
      `${ESC}[90m${ESC}]8;;file:///workspace/a.ts${BEL}` +
      `a${ESC}[38:5:244mb${ESC}]8;;${BEL} tail`;

    expect(colorizer.write(input)).toBe(
      `${ESC}[90m${ESC}]8;;file:///workspace/a.ts${BEL}${ESC}[34m` +
        `a${ESC}[38:5:244m${ESC}[34mb${ESC}[38:5:244m${ESC}]8;;${BEL} tail`,
    );
  });

  it('does not parse OSC-looking bytes inside a passthrough control string', () => {
    const colorizer = new TerminalFileLinkColorizer();
    const input = `${ESC}Ppayload ${fileLink()}${ST} plain`;

    expect(colorizer.write(input)).toBe(input);
  });
});
