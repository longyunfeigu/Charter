import { describe, expect, it } from 'vitest';
import { buildIssueWorkspaceDirective } from './issueLaunchContext.js';

describe('imported issue launch workspace context', () => {
  it('directs the Agent to create a worktree without claiming Charter created it', () => {
    const prompt = buildIssueWorkspaceDirective({
      projectPath: '/repo',
      baseBranch: 'release/next',
      currentBranch: 'main',
      mode: 'agent-worktree',
    });

    expect(prompt).toContain('Selected base branch: "release/next"');
    expect(prompt).toContain('create a new linked Git worktree');
    expect(prompt).toContain('Charter will not create or manage this worktree');
    expect(prompt).toContain('Do not switch branches or modify files in the original checkout');
  });

  it('makes a different checkout branch an explicit safe Agent action', () => {
    const prompt = buildIssueWorkspaceDirective({
      projectPath: '/repo',
      baseBranch: 'feature/import',
      currentBranch: 'main',
      mode: 'checkout',
    });

    expect(prompt).toContain('Selected working branch: "feature/import"');
    expect(prompt).toContain('Switch to "feature/import" only if it is safe');
    expect(prompt).toContain('Never discard, overwrite, or automatically stash');
    expect(prompt).not.toContain('create a new linked Git worktree');
  });
});
