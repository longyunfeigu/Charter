import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  nearestStepIndex,
  stepZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  zoomPercentLabel,
} from '../../apps/desktop-renderer/src/views/ui-zoom';

describe('UI zoom ladder (M11-05, A11Y-003)', () => {
  it('spans exactly 80%–200%', () => {
    expect(ZOOM_MIN).toBe(0.8);
    expect(ZOOM_MAX).toBe(2);
    expect(ZOOM_STEPS[0]).toBe(0.8);
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(2);
  });

  it('steps up and down the ladder, clamping at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(2, 1)).toBe(2); // clamp at max
    expect(stepZoom(0.8, -1)).toBe(0.8); // clamp at min
  });

  it('snaps an arbitrary persisted scale to the nearest ladder step', () => {
    expect(ZOOM_STEPS[nearestStepIndex(1.03)]).toBe(1);
    expect(ZOOM_STEPS[nearestStepIndex(1.4)]).toBe(1.5);
    expect(stepZoom(1.03, 1)).toBe(1.1); // steps from the nearest (1) not the raw value
  });

  it('clamps out-of-range and non-finite scales', () => {
    expect(clampZoom(5)).toBe(2);
    expect(clampZoom(0.1)).toBe(0.8);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(1.25)).toBe(1.25);
  });

  it('formats a percent label', () => {
    expect(zoomPercentLabel(1)).toBe('100%');
    expect(zoomPercentLabel(0.8)).toBe('80%');
    expect(zoomPercentLabel(1.75)).toBe('175%');
  });
});
