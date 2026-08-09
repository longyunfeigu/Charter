/**
 * Deterministic heavy-markdown transcript seeding shared by the perf benches
 * (scroll-bench keeps its own inline copy from the ADR-0052 run; this module
 * serves the ADR-0055 switch bench). Mock-backend only (CLAUDE.md §10).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SEED_EVENTS = 400;

export function heavyMarkdown(i: number, prefix: string): string {
  const giant = i % 8 === 0;
  const tableRows = Array.from(
    { length: giant ? 30 : 5 },
    (_, r) =>
      `| ${prefix}_evt_${i}_${r} | handler_${r % 9} | ${r % 2 ? 'yes' : 'no'} | retry=${r % 5} | \`src/${prefix}_${i}_${r}.ts\` |`,
  );
  const codeLines = Array.from(
    { length: giant ? 60 : 12 },
    (_, r) => `  const step${r} = await pipeline.stage(${r}, ctx, { tag: '${prefix}_${i}_${r}' });`,
  );
  return [
    `### ${prefix} analysis step ${i}`,
    '',
    `Reviewing \`src/${prefix}_module_${i}.ts\`: the handler wires **${3 + (i % 4)} services** together and re-exports the public surface.`,
    '',
    '| Id | Handler | Nullable | Notes | Source |',
    '|---|---|---|---|---|',
    ...tableRows,
    '',
    '```ts',
    `export async function process_${prefix}_${i}(input: Input): Promise<Result> {`,
    ...codeLines,
    '  return finalize(ctx);',
    '}',
    '```',
    '',
    `- verified against ${prefix} fixture ${i}`,
  ].join('\n');
}

/** Insert a deterministic heavy transcript for one task; `prefix` keys the content. */
export function seedTranscript(
  dbPath: string,
  taskId: string,
  prefix: string,
  resultsDir: string,
): void {
  const maxSeq = Number(
    execFileSync('sqlite3', [
      dbPath,
      `SELECT COALESCE(MAX(sequence),0) FROM task_events WHERE task_id='${taskId}';`,
    ])
      .toString()
      .trim(),
  );
  const lines: string[] = ['BEGIN;'];
  const base = Date.now() - SEED_EVENTS * 1000;
  for (let i = 0; i < SEED_EVENTS; i++) {
    const seq = maxSeq + 1 + i;
    const at = new Date(base + i * 1000).toISOString();
    let type: string;
    let payload: unknown;
    if (i % 13 === 12) {
      type = 'task.stateChanged';
      payload = { from: 'EXPLORING', to: 'IN_PROGRESS' };
    } else if (i % 10 === 9) {
      type = 'user.message';
      payload = { messageId: `msg_${prefix}_u${i}`, text: `Follow-up ${prefix} question ${i}.` };
    } else if (i % 3 === 1) {
      type = 'tool.call';
      payload = {
        callId: `ctl_${prefix}_${i}`,
        name: 'read_file',
        risk: 'R0',
        state: 'SUCCEEDED',
        ok: true,
        summary: `Read src/${prefix}_module_${i}.ts`,
        input: { path: `src/${prefix}_module_${i}.ts` },
      };
    } else {
      type = 'agent.message';
      payload = { messageId: `msg_${prefix}_${i}`, text: heavyMarkdown(i, prefix) };
    }
    const json = JSON.stringify(payload).replace(/'/g, "''");
    lines.push(
      `INSERT INTO task_events (id, task_id, sequence, type, schema_version, payload_json, created_at) VALUES ('evt_${prefix}_${i}', '${taskId}', ${seq}, '${type}', 1, '${json}', '${at}');`,
    );
  }
  lines.push('COMMIT;');
  const sqlFile = join(resultsDir, `seed-${prefix}.sql`);
  writeFileSync(sqlFile, lines.join('\n'));
  execFileSync('sqlite3', [dbPath], { input: `.read ${sqlFile}` });
}
