/**
 * Correction-similarity heuristic (ADR-0028). Deterministic and model-free:
 * used to (a) show "你第 N 次做类似纠正" on the distill card, (b) count a
 * correction as a hit against an existing rule ("it slipped again"), and
 * (c) dedupe candidates. Mixed-script aware: ASCII words + CJK bigrams.
 */

/**
 * Calibrated on paraphrased same-convention pairs (zh ≈ 0.37, en ≈ 0.55) vs
 * different-topic pairs (< 0.1) — 0.35 separates them with wide margins on
 * both sides. See similarity.test.ts fixtures.
 */
export const CORRECTION_SIMILAR_THRESHOLD = 0.35;

export function similarityTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const lowered = text.toLowerCase();
  // ASCII words / numbers (identifier-ish, keeps `default`, `export`, `vitest`).
  for (const match of lowered.matchAll(/[a-z0-9_$]{2,}/g)) tokens.add(match[0]);
  // CJK runs → bigrams (single CJK char counts when a run has length 1).
  for (const match of lowered.matchAll(/[぀-ヿ㐀-䶿一-鿿豈-﫿]+/g)) {
    const run = match[0];
    if (run.length === 1) tokens.add(run);
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

export function correctionSimilarity(a: string, b: string): number {
  const ta = similarityTokens(a);
  const tb = similarityTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const token of ta) if (tb.has(token)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function isSimilarCorrection(a: string, b: string): boolean {
  return correctionSimilarity(a, b) >= CORRECTION_SIMILAR_THRESHOLD;
}
