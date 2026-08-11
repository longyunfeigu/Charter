export type IssueWorkspaceMode = 'checkout' | 'agent-worktree';

export interface IssueWorkspaceDirectiveInput {
  projectPath: string;
  baseBranch: string | null;
  currentBranch: string | null;
  mode: IssueWorkspaceMode;
}

function promptValue(value: string): string {
  return JSON.stringify(value);
}

/**
 * Agent-owned workspace policy for an imported issue launch.
 *
 * This is deliberately prompt context, not a host-side git mutation. The
 * renderer never checks out the chosen branch and never asks Charter's task
 * service to create its managed worktree for this flow.
 */
export function buildIssueWorkspaceDirective(input: IssueWorkspaceDirectiveInput): string {
  const repository = promptValue(input.projectPath);
  const baseBranch = input.baseBranch ? promptValue(input.baseBranch) : null;

  if (input.mode === 'agent-worktree' && baseBranch) {
    return [
      '## Repository workspace instructions',
      `- Repository: ${repository}`,
      `- Selected base branch: ${baseBranch}`,
      '- Workspace mode: Agent-created Git worktree.',
      '',
      `Before making any edits, create a new linked Git worktree based on ${baseBranch} and create or use a task-specific branch inside that worktree.`,
      'Perform all edits, installs, tests, and commits inside the new worktree. Do not switch branches or modify files in the original checkout.',
      'Charter will not create or manage this worktree for you. Report the worktree path and task branch in your first progress update.',
      'If creating the worktree is unsafe or fails, stop and explain the blocker instead of editing the original checkout.',
    ].join('\n');
  }

  const lines = [
    '## Repository workspace instructions',
    `- Repository: ${repository}`,
    '- Workspace mode: Existing checkout.',
  ];
  if (baseBranch) {
    lines.push(
      `- Selected working branch: ${baseBranch}`,
      '',
      `Before making any edits, verify repository status and use ${baseBranch}.`,
    );
    if (input.currentBranch !== input.baseBranch) {
      lines.push(
        `The checkout was on ${promptValue(input.currentBranch ?? 'detached HEAD')} when this execution was launched. Switch to ${baseBranch} only if it is safe.`,
      );
    }
    lines.push(
      'Never discard, overwrite, or automatically stash existing local changes. Stop and report the blocker if the selected branch cannot be used safely.',
    );
  }
  return lines.join('\n');
}
