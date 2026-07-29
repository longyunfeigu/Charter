import { describe, expect, it } from 'vitest';
import {
  ArtifactFeedbackRefSchema,
  ArtifactFeedbackRefsSchema,
  ArtifactOpenResultSchema,
  formatPromptWithArtifactFeedback,
  type ArtifactFeedbackRefDto,
} from './artifacts.js';

function feedback(overrides: Partial<ArtifactFeedbackRefDto> = {}): ArtifactFeedbackRefDto {
  return {
    id: 'artifact-ref-1',
    taskId: 'task-1',
    path: 'reports/revenue.csv',
    contentHash: 'a'.repeat(64),
    artifactKind: 'table',
    anchor: { type: 'table', startRow: 4, endRow: 7, startColumn: 2, endColumn: 3 },
    note: 'The subtotal should exclude refunds.',
    createdAt: '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('Artifact feedback contracts', () => {
  it('accepts semantic anchors pinned to an immutable task/path/hash', () => {
    expect(ArtifactFeedbackRefSchema.parse(feedback()).anchor.type).toBe('table');
    expect(
      ArtifactFeedbackRefSchema.safeParse(
        feedback({
          artifactKind: 'html',
          path: 'reports/revenue.html',
          anchor: {
            type: 'html',
            selector: '#revenue',
            viewport: { width: 1280, height: 720 },
            mode: 'interactive',
            element: { tagName: 'h1', text: 'Revenue pulse' },
          },
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects path traversal, invalid hashes and reversed ranges', () => {
    expect(ArtifactFeedbackRefSchema.safeParse(feedback({ path: '../secret' })).success).toBe(
      false,
    );
    expect(
      ArtifactFeedbackRefSchema.safeParse(feedback({ contentHash: 'not-a-hash' })).success,
    ).toBe(false);
    expect(
      ArtifactFeedbackRefSchema.safeParse(
        feedback({ anchor: { type: 'text', startLine: 12, endLine: 3 } }),
      ).success,
    ).toBe(false);
  });

  it('bounds one reply to four artifact anchors', () => {
    const refs = Array.from({ length: 5 }, (_, index) => feedback({ id: `ref-${index}` }));
    expect(ArtifactFeedbackRefsSchema.safeParse(refs).success).toBe(false);
  });

  it('serializes hash, anchor and escaped note for any runtime', () => {
    const prompt = formatPromptWithArtifactFeedback('Fix the report.', [
      feedback({ note: 'Use <net> & preserve totals.' }),
    ]);
    expect(prompt).toContain('<artifact_feedback_context>');
    expect(prompt).toContain('path="reports/revenue.csv"');
    expect(prompt).toContain(`content_sha256="${'a'.repeat(64)}"`);
    expect(prompt).toContain('&lt;net&gt; &amp; preserve totals.');
    expect(prompt).toContain('"startRow":4');
    expect(prompt).toContain('report that the anchor was stale');
  });

  it('keeps source diagnostics structured and bounded', () => {
    const parsed = ArtifactOpenResultSchema.parse({
      artifact: {
        taskId: 'task-1',
        path: 'report.pdf',
        contentHash: 'a'.repeat(64),
        kind: 'pdf',
        mimeType: 'application/pdf',
        sizeBytes: 200,
        currentVersion: 1,
        versionCount: 1,
        updatedAt: '2026-07-22T00:00:00.000Z',
        producer: 'charter',
        captureGrade: 'full',
      },
      versions: [
        {
          contentHash: 'a'.repeat(64),
          version: 1,
          sizeBytes: 200,
          createdAt: '2026-07-22T00:00:00.000Z',
          isCurrent: true,
        },
      ],
      requestedHash: 'a'.repeat(64),
      stale: false,
      text: null,
      textTruncated: false,
      assetUrl: 'artifact://asset/token/report.pdf',
      diagnostics: [
        {
          code: 'pdf.symbol_font_without_unicode',
          level: 'warning',
          title: 'Glyph mapping missing',
          message: 'The source PDF cannot map these symbols back to Unicode.',
          repairHint: 'Regenerate with an embedded CJK font.',
        },
      ],
      archiveEntries: [],
      archiveTruncated: false,
    });
    expect(parsed.diagnostics[0]?.level).toBe('warning');
  });
});
