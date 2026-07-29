import { platform } from './bridge.js';

export interface Command {
  id: string;
  title: string;
  category?: string;
  keybinding?: string;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

const commands = new Map<string, Command>();
const isMac = platform() === 'darwin';

export function registerCommand(command: Command): void {
  commands.set(command.id, command);
}

export function registerCommands(list: Command[]): void {
  for (const c of list) registerCommand(c);
}

export function allCommands(): Command[] {
  return [...commands.values()].filter((c) => c.enabled?.() ?? true);
}

export function executeCommand(id: string): boolean {
  const command = commands.get(id);
  if (!command || (command.enabled && !command.enabled())) return false;
  void command.run();
  return true;
}

export function formatKeybinding(binding: string): string {
  return binding
    .split('+')
    .map((part) => {
      switch (part) {
        case 'mod':
          return isMac ? '⌘' : 'Ctrl';
        case 'shift':
          return isMac ? '⇧' : 'Shift';
        case 'alt':
          return isMac ? '⌥' : 'Alt';
        case 'ctrl':
          return isMac ? '⌃' : 'Ctrl';
        case 'escape':
          return 'Esc';
        case 'backquote':
          return '`';
        case 'plus':
          return '+';
        case 'minus':
          return '−';
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join(isMac ? '' : '+');
}

function matches(binding: string, e: KeyboardEvent): boolean {
  const parts = binding.split('+');
  const key = parts[parts.length - 1]!;
  const needMod = parts.includes('mod');
  const needShift = parts.includes('shift');
  const needAlt = parts.includes('alt');
  const needCtrl = parts.includes('ctrl');
  const modOk = needMod ? (isMac ? e.metaKey : e.ctrlKey) : isMac ? !e.metaKey : true;
  const ctrlOk = needCtrl ? e.ctrlKey : true;
  if (!modOk || !ctrlOk) return false;
  if (needShift !== e.shiftKey && key.length === 1) return false;
  if (needShift && !e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;
  const eventKey = e.key === ' ' ? 'space' : e.key.toLowerCase();
  const wanted = key === 'backquote' ? '`' : key.toLowerCase();
  if (wanted === 'plus') return eventKey === '+' || (e.code === 'Equal' && e.shiftKey);
  if (wanted === 'minus') return eventKey === '-' || e.code === 'Minus';
  return eventKey === wanted || (key === ',' && e.key === ',');
}

/** Global keydown dispatcher. Monaco and inputs stop propagation for their own bindings. */
export function handleGlobalKeydown(e: KeyboardEvent): boolean {
  for (const command of commands.values()) {
    if (!command.keybinding) continue;
    if (command.enabled && !command.enabled()) continue;
    if (matches(command.keybinding, e)) {
      e.preventDefault();
      e.stopPropagation();
      void command.run();
      return true;
    }
  }
  return false;
}
