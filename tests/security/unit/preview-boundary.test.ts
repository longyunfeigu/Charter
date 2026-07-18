import { describe, expect, it } from 'vitest';
import {
  isLoopbackPreviewUrl,
  PICKER_JS,
  PICKER_CANCEL_JS,
} from '../../../apps/desktop-main/src/services/preview-picker';
import {
  PREVIEW_SANDBOX,
  pickMessageOrigins,
} from '../../../apps/desktop-renderer/src/views/preview-security';
import { CSP } from '../../../apps/desktop-main/src/csp';

describe('preview injection boundary (ADR-0022 am.2, M11-01)', () => {
  it('injects only into plain-http loopback frames on the exact task port', () => {
    expect(isLoopbackPreviewUrl('http://localhost:5173/', 5173)).toBe(true);
    expect(isLoopbackPreviewUrl('http://127.0.0.1:5173/app', 5173)).toBe(true);

    expect(isLoopbackPreviewUrl('http://localhost:5174/', 5173)).toBe(false); // other port
    expect(isLoopbackPreviewUrl('http://localhost.evil.com:5173/', 5173)).toBe(false);
    expect(isLoopbackPreviewUrl('https://localhost:5173/', 5173)).toBe(false); // scheme pinned
    expect(isLoopbackPreviewUrl('file:///tmp/index.html', 5173)).toBe(false);
    expect(isLoopbackPreviewUrl('app://index.html', 5173)).toBe(false);
    expect(isLoopbackPreviewUrl('about:blank', 5173)).toBe(false);
    expect(isLoopbackPreviewUrl('', 5173)).toBe(false);
  });

  it('renderer pick listener accepts exactly the two loopback origins of the task port', () => {
    expect([...pickMessageOrigins(5173)].sort()).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]);
  });

  it('iframe sandbox grants are pinned', () => {
    expect(PREVIEW_SANDBOX).toBe('allow-scripts allow-same-origin allow-forms');
    // never silently gain these
    for (const grant of ['allow-top-navigation', 'allow-popups', 'allow-modals', 'allow-downloads'])
      expect(PREVIEW_SANDBOX).not.toContain(grant);
  });

  it('CSP frame-src grants loopback http only (matches the injection gate)', () => {
    const frameSrc = CSP.split('; ').find((d) => d.startsWith('frame-src'));
    expect(frameSrc).toBe('frame-src http://localhost:* http://127.0.0.1:*');
  });

  it('picker script is posts-only and self-cleaning — static audit', () => {
    // No network, storage, import or eval surface inside the injected code.
    for (const banned of [
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
      'import(',
      'eval(',
      'localStorage',
      'indexedDB',
      'document.cookie',
      'navigator.sendBeacon',
    ]) {
      expect(PICKER_JS).not.toContain(banned);
      expect(PICKER_CANCEL_JS).not.toContain(banned);
    }
    // It talks to the app exclusively via the two parent.postMessage envelopes…
    expect(PICKER_JS).toContain('parent.postMessage({ __charterPick:');
    expect(PICKER_JS).toContain("parent.postMessage({ __charterPickCancel: true }, '*')");
    // …and re-arming or cancelling always runs the previous cleanup.
    expect(PICKER_JS).toContain('if (window.__charterPickCleanup) window.__charterPickCleanup()');
    expect(PICKER_CANCEL_JS).toContain(
      'if (window.__charterPickCleanup) window.__charterPickCleanup()',
    );
  });
});
