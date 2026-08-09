export type RoomLocale = 'en' | 'zh';

export interface RoomCopy {
  locale: RoomLocale;
  you: string;
  charter: string;
  taskContext: string;
  acceptanceChecks: string;
  previousConversation: string;
  plan: string;
  steps: (count: number) => string;
  thinking: string;
  thought: string;
  reviewReady: string;
  reviewChanges: string;
  accept: string;
  checks: string;
  passed: string;
  failed: string;
  runChecks: string;
  noVerification: string;
  configuredChecksNotRun: (count: number) => string;
  risks: string;
  agentSummary: string;
  hideAgentSummary: string;
  evidenceNote: string;
  rollbackAll: string;
  discardWorktree: string;
}

const EN: RoomCopy = {
  locale: 'en',
  you: 'You',
  charter: 'Charter',
  taskContext: 'Session context',
  acceptanceChecks: 'Acceptance checks',
  previousConversation: 'Previous Session context attached',
  plan: 'Plan',
  steps: (count) => `${count} step${count === 1 ? '' : 's'}`,
  thinking: 'Thinking',
  thought: 'Thought',
  reviewReady: 'Ready to review',
  reviewChanges: 'Review changes',
  accept: 'Accept',
  checks: 'Checks',
  passed: 'passed',
  failed: 'failed',
  runChecks: 'Run checks',
  noVerification: 'Unverified — no verification commands were run.',
  configuredChecksNotRun: (count) =>
    `${count} configured check${count === 1 ? '' : 's'} ${count === 1 ? 'has' : 'have'} not run.`,
  risks: 'Risks',
  agentSummary: "Agent's summary",
  hideAgentSummary: 'Hide agent summary',
  evidenceNote: 'Change and verification facts come from recorded evidence.',
  rollbackAll: 'Roll back all…',
  discardWorktree: 'Discard worktree…',
};

const ZH: RoomCopy = {
  locale: 'zh',
  you: '你',
  charter: 'Charter',
  taskContext: 'Session 上下文',
  acceptanceChecks: '验收条件',
  previousConversation: '已附带上一 Session 的上下文',
  plan: '计划',
  steps: (count) => `${count} 步`,
  thinking: 'Thinking',
  thought: 'Thinking',
  reviewReady: '待审查',
  reviewChanges: '查看改动',
  accept: '接受',
  checks: '验证',
  passed: '通过',
  failed: '失败',
  runChecks: '运行验证',
  noVerification: '尚未验证——未运行任何验证命令。',
  configuredChecksNotRun: (count) => `有 ${count} 项已配置的验证尚未运行。`,
  risks: '风险',
  agentSummary: 'Agent 摘要',
  hideAgentSummary: '收起 Agent 摘要',
  evidenceNote: '改动与验证状态来自已记录的执行证据。',
  rollbackAll: '全部回滚…',
  discardWorktree: '丢弃工作树…',
};

export function roomCopyFor(_text: string): RoomCopy {
  return getLocale() === 'zh-CN' ? ZH : EN;
}
import { getLocale } from '../i18n.js';
