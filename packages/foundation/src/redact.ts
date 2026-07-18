const MASK = '[REDACTED]';

/** Patterns for secret material that must never reach logs, IPC dumps or support bundles. */
const TEXT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /sk-[A-Za-z0-9_-]{16,}/g, label: 'api-key' },
  { re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, label: 'github-token' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, label: 'github-token' },
  { re: /AKIA[0-9A-Z]{16}/g, label: 'aws-key' },
  { re: /xox[abprs]-[A-Za-z0-9-]{10,}/g, label: 'slack-token' },
  { re: /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, label: 'bearer' },
  { re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}/g, label: 'jwt' },
];

/** key=value / key: value assignments whose key looks credential-like. */
const KEY_VALUE_RE =
  /([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|credential|auth)[A-Za-z0-9_.-]*\s*[=:]\s*)(["']?)([^\s"'&;]{4,})\2/gi;

const SECRET_FIELD_RE =
  /^(api[-_]?key|.*secret.*|.*token.*|.*password.*|passwd|authorization|auth|credentials?|.*api[-_]?key.*|private[-_]?key)$/i;

export function redactText(text: string): string {
  let out = text;
  for (const { re, label } of TEXT_PATTERNS) {
    out = out.replace(re, `[REDACTED:${label}]`);
  }
  out = out.replace(KEY_VALUE_RE, (_m, prefix: string) => `${prefix}${MASK}`);
  return out;
}

export interface SecretFinding {
  label: string;
  match: string;
}

/**
 * Detect secret material in text (M11-02). Same pattern set as {@link redactText},
 * but returns the hits instead of masking — used by the artifact/repo secret
 * scanner and by the four-path "not detectable" verification. Returns [] when
 * clean.
 */
export function findSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const { re, label } of TEXT_PATTERNS) {
    for (const m of text.matchAll(re)) found.push({ label, match: m[0] });
  }
  for (const m of text.matchAll(KEY_VALUE_RE)) {
    // group 3 is the value; skip already-masked assignments
    if (m[3] && m[3] !== MASK && !m[3].startsWith('[REDACTED')) {
      found.push({ label: 'key-value', match: m[0] });
    }
  }
  return found;
}

export function redactObject(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactObject(v, seen));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_RE.test(key)) {
      out[key] = MASK;
    } else {
      out[key] = redactObject(v, seen);
    }
  }
  return out;
}
