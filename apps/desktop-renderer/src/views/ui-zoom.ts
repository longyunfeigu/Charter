/**
 * UI zoom ladder (M11-05, A11Y-003). general.uiScale drives real window zoom in
 * the main process (Monaco and the terminal scale with it). 80%–200% in the
 * steps the confirmed mock shows; ⌘+/⌘−/⌘0 walk the ladder. Pure so the ladder
 * math is unit-tested and shared by the commands and the Settings control.
 */
export const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 2;
export const ZOOM_DEFAULT = 1;

/** Nearest ladder index to an arbitrary (possibly persisted) scale. */
export function nearestStepIndex(scale: number): number {
  let best = 0;
  let bestDist = Infinity;
  ZOOM_STEPS.forEach((step, i) => {
    const d = Math.abs(step - scale);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/** One step up/down the ladder from the current scale, clamped. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  const idx = nearestStepIndex(scale);
  const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx + direction));
  return ZOOM_STEPS[next]!;
}

/** Clamp an arbitrary scale into the supported range. */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return ZOOM_DEFAULT;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
}

export function zoomPercentLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
