export interface ObservedSessionFile {
  path: string;
  status: string;
}

/** Resolve the shared Session file ledger from its most authoritative source. */
export function sessionFilePaths(input: {
  external: boolean;
  running: boolean;
  projectedChangeSetLoaded: boolean;
  projectedChangeFiles: readonly string[];
  observedExternalFiles: readonly ObservedSessionFile[];
  activityFiles: readonly string[];
}): string[] {
  if (input.external) {
    return input.projectedChangeSetLoaded
      ? [...input.projectedChangeFiles]
      : input.observedExternalFiles
          .filter((file) => file.status !== 'deleted')
          .map((file) => file.path);
  }
  if (input.projectedChangeSetLoaded && !input.running) {
    return [...input.projectedChangeFiles];
  }
  return [...new Set([...input.activityFiles, ...input.projectedChangeFiles])];
}

/** The Diff heading and rows must always be projected from the same collection. */
export function displayedDiffFiles<T>(
  changeFiles: readonly T[],
  fallbackFiles: readonly string[],
): Array<T | string> {
  return changeFiles.length > 0 ? [...changeFiles] : [...fallbackFiles];
}
