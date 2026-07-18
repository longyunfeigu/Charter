import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  allowedNavigation,
  isAllowedExternalUrl,
} from '../../../apps/desktop-main/src/security-policy';

const fusePlan = createRequire(import.meta.url)('../../../scripts/fuse-plan.cjs') as {
  version: string;
  resetAdHocDarwinSignature: boolean;
  fuses: Record<string, boolean>;
};

describe('external URL policy (§16.4 malicious links)', () => {
  it('allows plain https only', () => {
    expect(isAllowedExternalUrl('https://example.com/docs')).toBe(true);
    expect(isAllowedExternalUrl('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it.each([
    'http://example.com', // downgrade
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'vscode://extension/install',
    'smb://server/share',
    ' https://padded.example', // no trimming — reject
    'https:/single-slash.example',
    '//protocol-relative.example',
    'app://index.html',
  ])('rejects %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });
});

describe('renderer navigation policy (§12.3)', () => {
  it('packaged mode: only app:// may navigate', () => {
    expect(allowedNavigation(undefined, 'app://index.html')).toBe(true);
    expect(allowedNavigation(undefined, 'https://example.com')).toBe(false);
    expect(allowedNavigation(undefined, 'file:///tmp/x.html')).toBe(false);
    expect(allowedNavigation(undefined, 'foo://bar')).toBe(false);
  });

  it('dev mode adds exactly the dev server origin', () => {
    const dev = 'http://localhost:5173';
    expect(allowedNavigation(dev, 'http://localhost:5173/index.html')).toBe(true);
    expect(allowedNavigation(dev, 'app://index.html')).toBe(true);
    expect(allowedNavigation(dev, 'http://localhost:5174/')).toBe(false);
    expect(allowedNavigation(dev, 'https://example.com')).toBe(false);
  });
});

describe('electron fuse plan pin (M11-01)', () => {
  it('locks the exact fuse wire the packaged app ships with', () => {
    expect(fusePlan.version).toBe('V1');
    expect(fusePlan.resetAdHocDarwinSignature).toBe(true);
    expect(fusePlan.fuses).toEqual({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
  });
});
