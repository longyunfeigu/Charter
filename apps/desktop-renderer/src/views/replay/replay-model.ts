import type {
  ReplayChapterCategory,
  ReplayEvidenceLevel,
  ReplayFactDto,
} from '@pi-ide/ipc-contracts';

/**
 * Renderer-side replay helpers (Replay V3). All trust-critical derivation
 * (levels, story time, chapters, coverage) lives in @pi-ide/ipc-contracts —
 * this module only formats and routes what the projection already decided.
 */

export function formatReplayTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function formatDurationShort(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 6) / 10} h`;
}

export const KIND_ICON: Record<string, string> = {
  message: 'bot',
  question: 'help',
  answer: 'user',
  plan: 'map',
  'plan-decision': 'check',
  read: 'file',
  search: 'search',
  command: 'terminal',
  write: 'pencil',
  permission: 'shield',
  verification: 'checkCircle',
  review: 'eye',
  state: 'info',
  report: 'clipboard',
  system: 'sliders',
  user: 'user',
};

export const LEVEL_LABEL: Record<ReplayEvidenceLevel, string> = {
  verified: '已验证',
  recorded: '结构化记录',
  observed: '观察记录',
  inferred: '推导叙事',
  missing: '证据缺失',
};

export const CHAPTER_LABEL: Record<ReplayChapterCategory, string> = {
  request: '请求',
  approach: '方法',
  discovery: '发现',
  decision: '决策',
  pivot: '转折',
  change: '变更',
  problem: '问题',
  verification: '验证',
  result: '结果',
};

/** Short reversibility badge for outward-action rows — honest, never upgraded. */
export const REVERSIBILITY_BADGE: Record<ReplayFactDto['reversibility'], string> = {
  reversible: '可回滚',
  compensatable: '可补偿',
  irreversible: '不可逆',
  unknown: '可逆性未知',
};

export function labelSource(source: string): string {
  if (source === 'pi') return 'Pi Home';
  if (source === 'claude') return 'Claude Terminal';
  if (source === 'codex') return 'Codex Terminal';
  return 'External Terminal';
}

export function labelCapture(grade: string): string {
  if (grade === 'full') return '完整记录';
  if (grade === 'structured') return '结构化记录';
  return '观察记录';
}

export function labelReversibility(value: ReplayFactDto['reversibility']): string {
  switch (value) {
    case 'reversible':
      return '可回滚（字节级快照）';
    case 'compensatable':
      return '可补偿';
    case 'irreversible':
      return '不可逆';
    default:
      return '未知';
  }
}

/** UI grouping for filters/lanes — a presentation label, never an app identity claim. */
export function appLabel(fact: ReplayFactDto): string {
  if (fact.app) return fact.app;
  if (fact.kind === 'write' || fact.kind === 'read') return 'Files';
  if (fact.kind === 'command') return fact.toolName === 'terminal' ? 'Terminal' : 'Commands';
  if (fact.kind === 'search') return 'Search';
  if (fact.kind === 'verification') return 'Verification';
  if (fact.kind === 'permission' || fact.kind === 'review') return 'Approval';
  if (['message', 'question', 'answer', 'user'].includes(fact.kind)) return 'Conversation';
  if (['plan', 'plan-decision'].includes(fact.kind)) return 'Plan';
  return 'Agent';
}

// ---------- artifact renderer registry ----------

/** Chosen by evidence/target type — never by agent name (§6.4). */
export type ArtifactRendererId =
  | 'file'
  | 'terminal'
  | 'approval'
  | 'verification'
  | 'message'
  | 'document'
  | 'spreadsheet'
  | 'web'
  | 'generic';

const DOCUMENT_PATH = /\.(md|markdown|txt|rst|adoc)$/i;
const SHEET_PATH = /\.(csv|tsv)$/i;

export function rendererFor(fact: ReplayFactDto): ArtifactRendererId {
  if (fact.kind === 'write' && (fact.changeIds?.length ?? 0) > 0) {
    const path = fact.paths[0] ?? '';
    if (DOCUMENT_PATH.test(path)) return 'document';
    if (SHEET_PATH.test(path)) return 'spreadsheet';
    return 'file';
  }
  if (fact.kind === 'permission') return 'approval';
  if (fact.kind === 'verification') return 'verification';
  if (fact.toolName === 'terminal' || (fact.kind === 'command' && fact.capture === 'observed')) {
    return 'terminal';
  }
  if (['message', 'question', 'answer', 'user'].includes(fact.kind)) return 'message';
  const resource = (fact.resource ?? '').toLowerCase();
  if (resource.startsWith('http://') || resource.startsWith('https://')) return 'web';
  return 'generic';
}

// ---------- question-shaped filters (§Explore) ----------

export type ReplayQuestionFilter =
  'all' | 'changed' | 'decisions' | 'attention' | 'approvals' | 'unverified';

export const QUESTION_FILTERS: Array<{ id: ReplayQuestionFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'changed', label: '发生了什么变化？' },
  { id: 'decisions', label: '做了哪些决策？' },
  { id: 'attention', label: '哪里需要注意？' },
  { id: 'approvals', label: '哪些需要审批？' },
  { id: 'unverified', label: '哪些尚未验证？' },
];

export function matchesQuestionFilter(fact: ReplayFactDto, filter: ReplayQuestionFilter): boolean {
  switch (filter) {
    case 'changed':
      return fact.lane === 'artifacts' || (fact.changeIds?.length ?? 0) > 0;
    case 'decisions':
      return ['permission', 'plan-decision', 'plan', 'review'].includes(fact.kind);
    case 'attention':
      return fact.status === 'error' || fact.status === 'denied' || fact.status === 'warn';
    case 'approvals':
      return fact.kind === 'permission';
    case 'unverified':
      return fact.level === 'observed' || fact.level === 'inferred' || fact.level === 'missing';
    default:
      return true;
  }
}

export function matchesSearch(fact: ReplayFactDto, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    fact.action.toLowerCase().includes(q) ||
    (fact.detail ?? '').toLowerCase().includes(q) ||
    fact.paths.some((p) => p.toLowerCase().includes(q)) ||
    appLabel(fact).toLowerCase().includes(q)
  );
}
