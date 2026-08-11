import type { Logger } from '@pi-ide/foundation';
import type { GithubIssueService } from '../services/github-issue-service.js';
import { registerHandlers } from './router.js';

export function registerGithubHandlers(service: GithubIssueService, logger: Logger): void {
  registerHandlers(
    {
      'github.issue.resolve': async ({ url }) => service.resolveIssue(url),
      'github.issue.import': async ({ url, projectPath }) => service.importIssue(url, projectPath),
      'github.issue.postComment': async ({ workItemId, body }) =>
        service.postIssueComment(workItemId, body),
      'github.auth.status': async () => service.authStatus(),
      'github.auth.setToken': async ({ token }) => service.setToken(token),
      'github.auth.clearToken': async () => ({ cleared: service.clearToken() }),
    },
    logger,
  );
}
