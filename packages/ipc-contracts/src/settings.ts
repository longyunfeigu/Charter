import { z } from 'zod';

import { SshHostRecordSchema } from './ssh.js';

export const SETTINGS_SCHEMA_VERSION = 1;

export const ThemeSchema = z.enum(['light', 'dark', 'system']);
export const AppLocaleSchema = z.enum(['en', 'zh-CN']);
export const SkinSchema = z.enum(['studio', 'terminal', 'archive', 'index', 'atelier', 'codex']);
export const DEFAULT_EDITOR_FONT_FAMILY =
  "Menlo, Monaco, 'SF Mono', Consolas, 'Courier New', monospace";
export const DEFAULT_TERMINAL_FONT_FAMILY =
  "'SF Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', monospace";
export const DEFAULT_TERMINAL_FONT_SIZE = 15;
export const DEFAULT_TERMINAL_FONT_WEIGHT = 500;
export const DEFAULT_TERMINAL_LINE_HEIGHT = 1.2;
export const DEFAULT_TERMINAL_PADDING_X = 12;
export const DEFAULT_TERMINAL_PADDING_Y = 10;

export const SettingsSchema = z.object({
  schemaVersion: z.number().int().default(SETTINGS_SCHEMA_VERSION),
  general: z
    .object({
      /** Display language for Charter-owned UI. User content and tool output are never translated. */
      locale: AppLocaleSchema.default('en'),
      theme: ThemeSchema.default('system'),
      /** Coordinated color, typography, icon and syntax-highlight language. */
      skin: SkinSchema.default('studio'),
      uiScale: z.number().min(0.8).max(2).default(1),
      confirmOnQuitWithRunningAgent: z.boolean().default(true),
    })
    .prefault({}),
  editor: z
    .object({
      fontSize: z.number().min(8).max(40).default(13),
      fontFamily: z.string().default(DEFAULT_EDITOR_FONT_FAMILY),
      lineHeight: z.number().min(1).max(3).default(1.55),
      tabSize: z.number().int().min(1).max(8).default(2),
      insertSpaces: z.boolean().default(true),
      wordWrap: z.enum(['off', 'on']).default('off'),
      minimap: z.boolean().default(true),
      renderWhitespace: z.enum(['none', 'boundary', 'all']).default('none'),
      autoSave: z.enum(['off', 'afterDelay', 'onFocusChange']).default('off'),
      autoSaveDelayMs: z.number().int().min(200).max(60000).default(1000),
      largeFileSizeMb: z.number().min(1).max(512).default(10),
      /** Open .md files in the rich (Notion-style) editor by default (PIVOT-019). */
      markdownRichDefault: z.boolean().default(false),
    })
    .prefault({}),
  terminal: z
    .object({
      fontSize: z.number().min(8).max(32).default(DEFAULT_TERMINAL_FONT_SIZE),
      fontFamily: z.string().min(1).default(DEFAULT_TERMINAL_FONT_FAMILY),
      fontWeight: z.number().int().min(100).max(900).default(DEFAULT_TERMINAL_FONT_WEIGHT),
      lineHeight: z.number().min(1).max(2).default(DEFAULT_TERMINAL_LINE_HEIGHT),
      paddingX: z.number().int().min(0).max(32).default(DEFAULT_TERMINAL_PADDING_X),
      paddingY: z.number().int().min(0).max(32).default(DEFAULT_TERMINAL_PADDING_Y),
      /** Orca uses WCAG-corrected Tango Light/Ghostty Dark palettes. Skin
       * retains Charter's coordinated legacy terminal palettes. */
      colorTheme: z.enum(['orca', 'skin']).default('orca'),
      shellPath: z.string().nullable().default(null),
      scrollback: z.number().int().min(100).max(200000).default(5000),
      /** Prefer the WebGL renderer, but always fall back to xterm's software
       * renderer when GPU setup or the canvas context fails. */
      renderer: z.enum(['auto', 'software']).default('auto'),
      /** Unicode 11 has more complete CJK/emoji width data; Unicode 6 remains
       * available for TUIs whose wcwidth table expects xterm's core default. */
      unicodeVersion: z.enum(['6', '11']).default('11'),
      /** ADR-0017 rev.2: auto-move a detected external CLI session to the side
       * panel. Off = detection only decorates in place; moving is a user action. */
      autoPromoteExternal: z.boolean().default(false),
      /** ADR-0021: inject OSC 133/9;4 shell integration (zsh/bash/fish). Off or
       * an unknown shell degrades to today's plain scrollback — never errors. */
      shellIntegration: z.boolean().default(true),
      /** ADR-0021: minimum command runtime before an unfocused finish notifies. */
      longCommandSeconds: z.number().int().min(5).max(600).default(15),
    })
    .prefault({}),
  agent: z
    .object({
      defaultMode: z.enum(['ask', 'edit', 'auto']).default('edit'),
      /** Auto mode may auto-approve R1 workspace writes when enabled (spec §19.3 default: off → R0 only). */
      autoApproveR1: z.boolean().default(false),
      /** Auto mode may auto-approve recognized verification commands (R2). */
      autoApproveKnownR2: z.boolean().default(false),
      maxOutputKb: z.number().int().min(64).max(4096).default(1024),
      /** Concurrent agent runs in the open workspace; extra starts queue FIFO (ADR-0006; 1 = pre-ADR behavior). */
      maxConcurrentRuns: z.number().int().min(1).max(8).default(3),
      /** ADR-0011: stream + record the model's thinking (collapsed in the UI,
       * excluded from the evidence system). */
      showThinking: z.boolean().default(true),
    })
    .prefault({}),
  orchestration: z
    .object({
      /** ADR-0044 circuit breaker: off means no tools, socket, or UI. */
      enabled: z.boolean().default(true),
      maxWorkers: z.number().int().min(1).max(12).default(5),
      maxSendsPerMinute: z.number().int().min(1).max(120).default(30),
    })
    .prefault({}),
  notifications: z
    .object({
      /** System notifications on plan-approval / permission / review-ready / failed (PIVOT-014). */
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  preview: z
    .object({
      /** ADR-0022 am.2: preview console errors → agent. auto = errors that land
       * right after the agent's own write are steered back automatically
       * (deduped, rate-limited); manual = collect + one-click send; off = count only. */
      consoleToAgent: z.enum(['auto', 'manual', 'off']).default('auto'),
    })
    .prefault({}),
  memory: z
    .object({
      /** ADR-0028: offer a distill card after review corrections (request-fix /
       * plan changes). Off = corrections are never captured as candidates. */
      captureEnabled: z.boolean().default(true),
    })
    .prefault({}),
  models: z
    .object({
      defaultProviderId: z.string().nullable().default(null),
      defaultModelId: z.string().nullable().default(null),
      defaultThinkingLevel: z
        .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        .default('medium'),
      /** Use the deterministic mock runtime instead of Pi (dev/test only). */
      useMockRuntime: z.boolean().default(false),
    })
    .prefault({}),
  privacy: z
    .object({
      telemetryEnabled: z.boolean().default(false),
      crashReportsEnabled: z.boolean().default(false),
    })
    .prefault({}),
  updates: z
    .object({
      channel: z.enum(['stable', 'beta']).default('stable'),
      autoCheck: z.boolean().default(true),
    })
    .prefault({}),
  workspace: z
    .object({
      ignoreGlobs: z.array(z.string()).default([]),
      trustProjectPiResources: z.boolean().default(false),
    })
    .prefault({}),
  /** ADR-0047: SSH host book — non-sensitive metadata only. Passwords and key
   * passphrases live in the OS keychain (SshVaultService), never here. */
  ssh: z
    .object({
      hosts: z.array(SshHostRecordSchema).default([]),
      /** Keepalive probe interval; 0 disables application-level keepalive. */
      keepaliveSeconds: z.number().int().min(0).max(600).default(30),
      /** Auto-reconnect the transport with exponential backoff on drops. */
      autoReconnect: z.boolean().default(true),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type AppLocale = z.infer<typeof AppLocaleSchema>;

/** Sections that a workspace override may touch (WS-014). */
export const WORKSPACE_OVERRIDABLE_SECTIONS = [
  'editor',
  'terminal',
  'agent',
  'models',
  'workspace',
] as const;
