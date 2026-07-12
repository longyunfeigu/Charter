import React, { useEffect, useState } from 'react';
import { monaco } from '../monaco-setup.js';
import { useEditorStore } from '../store/editorStore.js';
import { revealPosition } from './SearchView.js';

export interface ProblemEntry {
  path: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  column: number;
  source: string;
}

let listeners: Array<(problems: ProblemEntry[]) => void> = [];
let current: ProblemEntry[] = [];

function collect(): ProblemEntry[] {
  const markers = monaco.editor.getModelMarkers({});
  return markers
    .filter((m) => m.resource.scheme === 'pi-ws')
    .map((m) => ({
      path: m.resource.path.slice(1),
      message: m.message,
      severity:
        m.severity === monaco.MarkerSeverity.Error
          ? ('error' as const)
          : m.severity === monaco.MarkerSeverity.Warning
            ? ('warning' as const)
            : ('info' as const),
      line: m.startLineNumber,
      column: m.startColumn,
      source: m.source ?? m.owner ?? '',
    }));
}

export function initProblems(): void {
  monaco.editor.onDidChangeMarkers(() => {
    current = collect();
    for (const listener of listeners) listener(current);
  });
}

export function useProblems(): ProblemEntry[] {
  const [problems, setProblems] = useState<ProblemEntry[]>(current);
  useEffect(() => {
    const listener = (p: ProblemEntry[]) => setProblems(p);
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }, []);
  return problems;
}

export function problemCounts(problems: ProblemEntry[]): { errors: number; warnings: number } {
  return {
    errors: problems.filter((p) => p.severity === 'error').length,
    warnings: problems.filter((p) => p.severity === 'warning').length,
  };
}

export function ProblemsPanel(): React.JSX.Element {
  const problems = useProblems();
  const openFile = useEditorStore((s) => s.openFile);

  if (problems.length === 0) {
    return (
      <div className="empty-state" data-testid="problems-empty">
        No problems detected in open code.
      </div>
    );
  }

  const byFile = new Map<string, ProblemEntry[]>();
  for (const problem of problems) {
    const list = byFile.get(problem.path) ?? [];
    list.push(problem);
    byFile.set(problem.path, list);
  }

  return (
    <div style={{ fontSize: 12 }} data-testid="problems-panel">
      {[...byFile.entries()].map(([path, list]) => (
        <div key={path}>
          <div style={{ padding: '4px 10px', fontWeight: 600 }} className="mono">
            {path} <span className="text-muted">({list.length})</span>
          </div>
          {list.map((problem, i) => (
            <button
              key={i}
              className="quickpick-item"
              style={{ paddingLeft: 24 }}
              data-testid={`problem-${problem.severity}`}
              onClick={() => {
                void openFile(path).then(() => revealPosition(path, problem.line, problem.column));
              }}
            >
              <span
                className={
                  problem.severity === 'error'
                    ? 'text-danger'
                    : problem.severity === 'warning'
                      ? 'text-warning'
                      : 'text-muted'
                }
                aria-label={problem.severity}
              >
                {problem.severity === 'error' ? '✖' : problem.severity === 'warning' ? '▲' : 'ℹ'}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {problem.message}
              </span>
              <span className="qp-detail">
                [{problem.line}, {problem.column}] {problem.source}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
