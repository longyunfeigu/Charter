import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./bridge.js', () => ({ platform: () => 'darwin' }));

import { formatKeybinding, handleGlobalKeydown, registerCommands } from './commands.js';

const zoomIn = vi.fn();
const zoomOut = vi.fn();
const zoomReset = vi.fn();

registerCommands([
  { id: 'test.zoomIn', title: 'Zoom In', keybinding: 'mod+plus', run: zoomIn },
  { id: 'test.zoomOut', title: 'Zoom Out', keybinding: 'mod+minus', run: zoomOut },
  { id: 'test.zoomReset', title: 'Reset Zoom', keybinding: 'mod+0', run: zoomReset },
]);

function keyEvent(
  key: string,
  code: string,
  options: { metaKey?: boolean; shiftKey?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    code,
    metaKey: options.metaKey ?? false,
    ctrlKey: false,
    altKey: false,
    shiftKey: options.shiftKey ?? false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe('global zoom shortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('recognizes the physical plus key on a standard keyboard', () => {
    const event = keyEvent('+', 'Equal', { metaKey: true, shiftKey: true });
    expect(handleGlobalKeydown(event)).toBe(true);
    expect(zoomIn).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it('recognizes minus and reset without triggering without the modifier', () => {
    expect(handleGlobalKeydown(keyEvent('-', 'Minus', { metaKey: true }))).toBe(true);
    expect(handleGlobalKeydown(keyEvent('0', 'Digit0', { metaKey: true }))).toBe(true);
    expect(handleGlobalKeydown(keyEvent('+', 'Equal', { shiftKey: true }))).toBe(false);
    expect(zoomOut).toHaveBeenCalledOnce();
    expect(zoomReset).toHaveBeenCalledOnce();
  });

  it('renders readable shortcut labels', () => {
    expect(formatKeybinding('mod+plus')).toBe('⌘+');
    expect(formatKeybinding('mod+minus')).toBe('⌘−');
    expect(formatKeybinding('mod+0')).toBe('⌘0');
  });
});
