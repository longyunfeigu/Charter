import { describe, expect, it } from 'vitest';
import { displayedDiffFiles, sessionFilePaths } from './session-file-projection.js';

describe('Session file projection', () => {
  it('uses a complete ChangeSet instead of a partial external watcher ledger', () => {
    const projected = Array.from({ length: 6 }, (_, index) => `file-${index + 1}.ts`);
    expect(
      sessionFilePaths({
        external: true,
        running: true,
        projectedChangeSetLoaded: true,
        projectedChangeFiles: projected,
        observedExternalFiles: projected.slice(0, 3).map((path) => ({ path, status: 'created' })),
        activityFiles: [],
      }),
    ).toEqual(projected);
  });

  it('counts the same complete collection that the Diff rows render', () => {
    const changeFiles = Array.from({ length: 6 }, (_, index) => ({ path: `file-${index + 1}.ts` }));
    expect(displayedDiffFiles(changeFiles, ['file-1.ts', 'file-2.ts', 'file-3.ts'])).toHaveLength(
      6,
    );
  });
});
