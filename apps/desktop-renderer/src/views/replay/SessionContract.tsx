import React from 'react';
import type { ReplaySessionDto } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';
import { formatDurationShort } from './replay-model.js';

const VERIFICATION_LABEL = {
  verified: '已验证',
  partial: '部分验证',
  unverified: '未验证',
} as const;

function displayGoal(goal: string): string {
  return goal.replace(/^\[scenario:[^\]]+\]\s*/i, '').trim() || '未记录原始目标';
}

/**
 * The session contract (persistent at every depth): original goal, outcome,
 * verification state, elapsed time, the recorded input ledger (V3.1) and the
 * measured coverage band. Memory/rule injections are not ledgered yet — the
 * inputs cell says so instead of guessing.
 */
export function SessionContract({ session }: { session: ReplaySessionDto }): React.JSX.Element {
  const total = session.coverage.reduce((sum, c) => sum + (c.actualEndMs - c.actualStartMs), 0);
  const inputFiles = session.inputs.files;
  return (
    <section className="rp-contract" data-testid="replay-contract" aria-label="Session contract">
      <div className="rp-contract-goal">
        <span>原始目标</span>
        <strong className={session.goalRecorded ? '' : 'rp-goal-missing'}>
          {displayGoal(session.goal)}
        </strong>
      </div>
      <div className="rp-contract-fact">
        <span>结果</span>
        <strong className={`rp-outcome-${session.outcome}`} data-testid="replay-outcome">
          <Ic
            name={
              session.outcome === 'completed'
                ? 'checkCircle'
                : session.outcome === 'running'
                  ? 'clock'
                  : session.outcome === 'attention'
                    ? 'alert'
                    : 'square'
            }
            size={13}
          />
          {session.outcomeLabel}
        </strong>
      </div>
      <div className="rp-contract-fact">
        <span>验证</span>
        <strong className={`rp-verification-${session.verification}`}>
          {VERIFICATION_LABEL[session.verification]}
        </strong>
      </div>
      <div className="rp-contract-fact">
        <span>用时</span>
        <strong className="rp-contract-time">
          {formatDurationShort(session.actualDurationMs)} <small>实际</small>
          <em>·</em>
          {formatDurationShort(session.storyDurationMs)} <small>故事</small>
        </strong>
      </div>
      <div className="rp-contract-fact rp-contract-inputs">
        <span>喂给 Agent 的输入</span>
        <details data-testid="replay-inputs">
          <summary>
            <strong>
              {inputFiles.length > 0 ? `${inputFiles.length} 个文件引用` : '未记录注入清单'}
            </strong>
            <em>展开 ▾</em>
          </summary>
          <div className="rp-inputs-pop">
            <h4>文件引用（随请求附带）</h4>
            {inputFiles.length > 0 ? (
              <ul>
                {inputFiles.map((file) => (
                  <li key={file} className="mono">
                    {file}
                  </li>
                ))}
              </ul>
            ) : (
              <p>本次请求未附带文件引用。</p>
            )}
            <h4>记忆与规则</h4>
            <p className="rp-inputs-note">注入清单未入账本 — 回放不做声称。</p>
          </div>
        </details>
      </div>
      <div className="rp-contract-fact rp-contract-coverage">
        <span>证据覆盖</span>
        <div className="rp-mini-coverage" aria-label="Evidence coverage by interval">
          {session.coverage.map((segment, index) => (
            <i
              key={`${segment.level}-${index}`}
              className={`rp-cov-${segment.level}`}
              style={{
                width: `${total > 0 ? ((segment.actualEndMs - segment.actualStartMs) / total) * 100 : 0}%`,
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
