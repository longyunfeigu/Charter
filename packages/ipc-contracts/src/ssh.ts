import { z } from 'zod';

/**
 * SSH Remotes contracts (ADR-0047).
 *
 * Security invariant: secrets flow renderer→main only. No response or event
 * schema in this module may carry a password, passphrase or key material —
 * `tests` under vitest.security assert this statically by field name.
 */

/** Same shape as provider ids: short, lowercase, filesystem-safe. */
export const SSH_HOST_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

export const SshAuthMethodSchema = z.enum(['agent', 'key', 'password']);

/** A local (-L style) port forward persisted on its host record (PR3).
 * Runtime on/off state lives in the forward service, not in settings. */
export const SshForwardRecordSchema = z.object({
  id: z.string().min(1).max(40),
  bindHost: z.string().min(1).max(255).default('127.0.0.1'),
  bindPort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1).max(255).default('127.0.0.1'),
  targetPort: z.number().int().min(1).max(65535),
});
export type SshForwardRecord = z.infer<typeof SshForwardRecordSchema>;

/** Renderer input for add/edit: id optional (host generates). */
export const SshForwardInputSchema = SshForwardRecordSchema.extend({
  id: z.string().min(1).max(40).optional(),
});
export type SshForwardInput = z.infer<typeof SshForwardInputSchema>;

/** Non-sensitive host metadata persisted in settings.ssh (spec §11.1). */
export const SshHostRecordSchema = z.object({
  id: z.string().regex(SSH_HOST_ID_RE),
  label: z.string().min(1).max(80),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64),
  auth: SshAuthMethodSchema.default('agent'),
  /** Private key path for auth='key'. Expanded ~ is resolved by the host. */
  identityFile: z.string().max(1024).nullable().default(null),
  /** Single hop: a saved host's label/id or "user@host[:port]" (ADR-0047). */
  proxyJump: z.string().max(255).nullable().default(null),
  tags: z.array(z.string().min(1).max(24)).max(8).default([]),
  /** Directory a new remote session cd's into; null = login default. */
  remoteWorkdir: z.string().max(1024).nullable().default(null),
  /** Saved local port forwards (PR3); managed via ssh.saveForward/deleteForward. */
  forwards: z.array(SshForwardRecordSchema).max(20).default([]),
  importedFrom: z.enum(['manual', 'ssh-config']).default('manual'),
  lastConnectedAt: z.string().nullable().default(null),
});
export type SshHostRecord = z.infer<typeof SshHostRecordSchema>;

/** Renderer input for create/edit: id optional (host generates), bookkeeping
 * and forwards host-owned (the host dialog must not clobber saved forwards). */
export const SshHostInputSchema = SshHostRecordSchema.omit({
  importedFrom: true,
  lastConnectedAt: true,
  forwards: true,
}).extend({
  id: z.string().regex(SSH_HOST_ID_RE).optional(),
});
export type SshHostInput = z.infer<typeof SshHostInputSchema>;

export const SshConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
]);
export type SshConnectionState = z.infer<typeof SshConnectionStateSchema>;

export const SshConnectionDtoSchema = z.object({
  state: SshConnectionStateSchema,
  /** Live terminal sessions multiplexed on this connection. */
  sessions: z.number().int().min(0),
  error: z.string().nullable(),
});

export const SshHostDtoSchema = SshHostRecordSchema.extend({
  hasPassword: z.boolean(),
  hasPassphrase: z.boolean(),
  connection: SshConnectionDtoSchema,
});
export type SshHostDto = z.infer<typeof SshHostDtoSchema>;

/** Versioned remote change-plane required for managed Agent Sessions. */
export const SshWorkerStatusSchema = z.object({
  state: z.enum(['ready', 'missing', 'outdated', 'unsupported', 'error']),
  version: z.string().nullable(),
  protocol: z.number().int().nullable(),
  message: z.string().max(1000),
  installPath: z.string().max(4096).nullable(),
  nodePath: z.string().max(4096).nullable(),
});
export type SshWorkerStatus = z.infer<typeof SshWorkerStatusSchema>;

/** One parsed ~/.ssh/config entry offered by the import preview. */
export const SshConfigCandidateSchema = z.object({
  alias: z.string().min(1).max(255),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(64).nullable(),
  identityFile: z.string().max(1024).nullable(),
  proxyJump: z.string().max(255).nullable(),
  /** True when the host book already has an entry imported from this alias. */
  alreadyImported: z.boolean(),
});
export type SshConfigCandidate = z.infer<typeof SshConfigCandidateSchema>;

export const SshSecretKindSchema = z.enum(['password', 'passphrase']);
export type SshSecretKind = z.infer<typeof SshSecretKindSchema>;

// ---------------------------------------------------------------------------
// SFTP (PR2) — byte streams never cross IPC; the renderer sees paths,
// listings and progress numbers only.

export const SftpEntrySchema = z.object({
  name: z.string().min(1).max(1024),
  type: z.enum(['file', 'dir', 'symlink', 'other']),
  /** True when the entry is a symlink (type reflects the resolved target). */
  symlink: z.boolean(),
  size: z.number().min(0),
  mtimeMs: z.number().nullable(),
});
export type SftpEntry = z.infer<typeof SftpEntrySchema>;

export const SftpTransferStatusSchema = z.enum(['running', 'done', 'error', 'canceled']);

/** Payload of the ssh.sftpProgress event — one per transfer state change /
 * throttled progress tick. */
export const SftpTransferStateSchema = z.object({
  transferId: z.string().min(1),
  hostId: z.string().min(1),
  direction: z.enum(['upload', 'download']),
  /** File name only — full local paths stay in the main process. */
  name: z.string().min(1).max(1024),
  doneBytes: z.number().min(0),
  totalBytes: z.number().min(0).nullable(),
  status: SftpTransferStatusSchema,
  error: z.string().nullable(),
});
export type SftpTransferState = z.infer<typeof SftpTransferStateSchema>;

// ---------------------------------------------------------------------------
// Port forwards (PR3) — runtime state, broadcast via ssh.forwardState.

export const SshForwardStatusSchema = z.enum(['stopped', 'active', 'error']);

export const SshForwardStateSchema = z.object({
  hostId: z.string().min(1),
  forwardId: z.string().min(1),
  status: SshForwardStatusSchema,
  error: z.string().nullable(),
  /** Live tunneled TCP connections through this forward. */
  connections: z.number().int().min(0),
});
export type SshForwardState = z.infer<typeof SshForwardStateSchema>;
