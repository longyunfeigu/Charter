/**
 * Accessible diff text mode (M11-05, A11Y-005). The inline/side-by-side diff is
 * hard for a screen reader to walk change-by-change; text mode linearizes each
 * run of changed lines into one focusable "change" with a plain-language
 * summary, and F7/⇧F7 step between them. Pure so the grouping + announcement
 * text are unit-tested; the component owns focus and the aria-live region.
 */

export interface DiffLine {
  kind: 'context' | 'addition' | 'deletion';
  lineNumber: number | null;
  text: string;
}

export interface DiffChange {
  index: number;
  /** First affected line number (new-side for additions, old-side for deletions). */
  line: number | null;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/** Group consecutive add/delete lines into changes; context lines separate them. */
export function groupChanges(lines: DiffLine[]): DiffChange[] {
  const changes: DiffChange[] = [];
  let current: DiffLine[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    const additions = current.filter((l) => l.kind === 'addition').length;
    const deletions = current.filter((l) => l.kind === 'deletion').length;
    const firstNumbered = current.find((l) => l.lineNumber !== null);
    changes.push({
      index: changes.length,
      line: firstNumbered?.lineNumber ?? null,
      additions,
      deletions,
      lines: current,
    });
    current = [];
  };
  for (const line of lines) {
    if (line.kind === 'context') flush();
    else current.push(line);
  }
  flush();
  return changes;
}

/** One-line kind label for a change (drives the card badge + announcement). */
export function changeKindLabel(change: DiffChange): string {
  if (change.additions > 0 && change.deletions > 0) return 'modified';
  if (change.additions > 0) return 'added';
  return 'removed';
}

/** Screen-reader announcement for a focused change. */
export function announceChange(path: string, change: DiffChange, total: number): string {
  const where = change.line !== null ? ` at line ${change.line}` : '';
  const kind = changeKindLabel(change);
  const counts =
    change.additions && change.deletions
      ? `${change.additions} added, ${change.deletions} removed`
      : change.additions
        ? `${change.additions} added`
        : `${change.deletions} removed`;
  return `Change ${change.index + 1} of ${total}, ${path}${where}: ${kind}, ${counts}.`;
}

/** Next focus index for F7 (dir 1) / ⇧F7 (dir -1), wrapping. */
export function nextChangeIndex(current: number, total: number, dir: 1 | -1): number {
  if (total === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : total - 1;
  return (current + dir + total) % total;
}
