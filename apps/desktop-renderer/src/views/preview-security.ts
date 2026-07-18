/**
 * Preview boundary constants (ADR-0022 am.2), extracted pure so the security
 * suite pins them: widening the iframe sandbox or the pick-message origin set
 * must fail a test, not slip through a refactor (M11-01).
 */

/** Sandbox grants for the task's dev-server iframe — exactly these, nothing more. */
export const PREVIEW_SANDBOX = 'allow-scripts allow-same-origin allow-forms';

/** The only window.message origins the picker listener accepts: the task's own loopback port. */
export function pickMessageOrigins(port: number): Set<string> {
  return new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}
