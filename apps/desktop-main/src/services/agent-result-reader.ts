import { open, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  claudeProjectDirName,
  discoverCliSessionId,
  isSafeCliSessionId,
} from './cli-session-locator.js';

const MAX_NATIVE_TAIL_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_DAY_DIRECTORIES = 16;
const CODEX_ROLLOUT_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface AgentResultSession {
  taskId: string | null;
  agent: string;
  connector: string | null;
  dataHome: string | null;
  cwd: string;
  sessionId: string | null;
  startedAtMs: number;
  endedAtMs: number;
  remote: boolean;
}

export interface NativeAgentResult {
  answer: string;
  connector: string;
  sessionId: string;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
}

interface ConnectorInput extends AgentResultSession {
  connector: string;
  dataHome: string;
  sessionId: string;
  maxBytes: number;
}

type ResultConnector = (input: ConnectorInput) => Promise<NativeAgentResult | null>;

async function readTail(path: string): Promise<string> {
  const info = await stat(path);
  const length = Math.min(info.size, MAX_NATIVE_TAIL_BYTES);
  if (length <= 0) return '';
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, info.size - length));
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (info.size > length) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    return text;
  } finally {
    await file.close();
  }
}

async function readFirstLine(path: string, maxBytes = 256 * 1024): Promise<string | null> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    if (newline < 0 && bytesRead === buffer.length) return null;
    return newline >= 0 ? text.slice(0, newline) : text;
  } finally {
    await file.close();
  }
}

function jsonLines(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        rows.push(value as Record<string, unknown>);
      }
    } catch {
      // Native histories are append-only. Ignore a partial final write and
      // malformed records without allowing them to poison the latest result.
    }
  }
  return rows;
}

function bytePrefix(text: string, maxBytes: number): { text: string; totalBytes: number } {
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) return { text, totalBytes };
  let value = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  if (value.endsWith('\uFFFD')) value = value.slice(0, -1);
  return { text: value, totalBytes };
}

function result(input: ConnectorInput, answer: string | null): NativeAgentResult | null {
  const cleaned = answer?.trim();
  if (!cleaned) return null;
  const bounded = bytePrefix(cleaned, input.maxBytes);
  return {
    answer: bounded.text,
    connector: input.connector,
    sessionId: input.sessionId,
    bytes: Buffer.byteLength(bounded.text, 'utf8'),
    totalBytes: bounded.totalBytes,
    truncated: bounded.totalBytes > input.maxBytes,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readClaude(input: ConnectorInput): Promise<NativeAgentResult | null> {
  const path = join(
    input.dataHome,
    'projects',
    claudeProjectDirName(input.cwd),
    `${input.sessionId}.jsonl`,
  );
  let latest: string | null = null;
  for (const row of jsonLines(await readTail(path))) {
    if (row.type !== 'assistant' || row.isSidechain === true) continue;
    const message = objectValue(row.message);
    if (message?.role !== 'assistant' || message.stop_reason !== 'end_turn') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map(objectValue)
      .filter((part): part is Record<string, unknown> => Boolean(part?.type === 'text'))
      .map((part) => stringValue(part.text) ?? '')
      .join('');
    if (text.trim()) latest = text;
  }
  return result(input, latest);
}

function dayKeys(startedAtMs: number, endedAtMs: number): string[] {
  const keys: string[] = [];
  for (
    let at = startedAtMs - DAY_MS;
    at <= endedAtMs + DAY_MS && keys.length < MAX_DAY_DIRECTORIES;
    at += DAY_MS
  ) {
    const date = new Date(at);
    const key = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

async function codexTranscript(input: ConnectorInput): Promise<string | null> {
  const wanted = input.sessionId.toLowerCase();
  for (const key of dayKeys(input.startedAtMs, input.endedAtMs)) {
    const directory = join(input.dataHome, 'sessions', key);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = CODEX_ROLLOUT_RE.exec(name);
      if (match?.[1]?.toLowerCase() !== wanted) continue;
      const path = join(directory, name);
      try {
        const line = await readFirstLine(path);
        if (!line) continue;
        const row = JSON.parse(line) as {
          type?: unknown;
          payload?: { id?: unknown; cwd?: unknown };
        };
        if (
          row.type === 'session_meta' &&
          typeof row.payload?.id === 'string' &&
          row.payload.id.toLowerCase() === wanted &&
          typeof row.payload.cwd === 'string' &&
          resolve(row.payload.cwd) === resolve(input.cwd)
        ) {
          return path;
        }
      } catch {
        // Ignore malformed or raced candidates.
      }
    }
  }
  return null;
}

async function readCodex(input: ConnectorInput): Promise<NativeAgentResult | null> {
  const path = await codexTranscript(input);
  if (!path) return null;
  let latest: string | null = null;
  for (const row of jsonLines(await readTail(path))) {
    if (row.type !== 'response_item') continue;
    const payload = objectValue(row.payload);
    if (
      payload?.type !== 'message' ||
      payload.role !== 'assistant' ||
      payload.phase !== 'final_answer'
    ) {
      continue;
    }
    const content = Array.isArray(payload.content) ? payload.content : [];
    const text = content
      .map(objectValue)
      .filter((part): part is Record<string, unknown> => Boolean(part?.type === 'output_text'))
      .map((part) => stringValue(part.text) ?? '')
      .join('');
    if (text.trim()) latest = text;
  }
  return result(input, latest);
}

async function kimiWirePath(input: ConnectorInput): Promise<string | null> {
  const sessionsRoot = resolve(input.dataHome, 'sessions');
  for (const row of jsonLines(await readTail(join(input.dataHome, 'session_index.jsonl')))) {
    if (
      row.sessionId !== input.sessionId ||
      typeof row.sessionDir !== 'string' ||
      typeof row.workDir !== 'string' ||
      resolve(row.workDir) !== resolve(input.cwd)
    ) {
      continue;
    }
    const sessionDir = resolve(row.sessionDir);
    const within = relative(sessionsRoot, sessionDir);
    if (
      !within ||
      within.startsWith('..') ||
      isAbsolute(within) ||
      basename(sessionDir) !== input.sessionId
    ) {
      continue;
    }
    return join(sessionDir, 'agents', 'main', 'wire.jsonl');
  }
  return null;
}

async function readKimi(input: ConnectorInput): Promise<NativeAgentResult | null> {
  const path = await kimiWirePath(input);
  if (!path) return null;
  const parts = new Map<string, string>();
  let latest: string | null = null;
  for (const row of jsonLines(await readTail(path))) {
    if (row.type !== 'context.append_loop_event') continue;
    const event = objectValue(row.event);
    if (!event) continue;
    const turnId = stringValue(row.turnId) ?? stringValue(event.turnId) ?? '';
    const step = String(event.step ?? event.stepUuid ?? row.step ?? row.stepUuid ?? '');
    const key = `${turnId}:${step}`;
    if (event.type === 'content.part') {
      const part = objectValue(event.part);
      if (part?.type === 'text' && typeof part.text === 'string') {
        parts.set(key, `${parts.get(key) ?? ''}${part.text}`);
      }
    } else if (event.type === 'step.end' && event.finishReason === 'end_turn') {
      const text = parts.get(key);
      if (text?.trim()) latest = text;
    }
  }
  return result(input, latest);
}

const RESULT_CONNECTORS: Readonly<Record<string, ResultConnector>> = {
  claude: readClaude,
  codex: readCodex,
  kimi: readKimi,
};

/** Reads only the latest provider-authored final answer. Adapter manifests
 * select a trusted host connector; provider ids never branch in semantic
 * control. Missing/unknown connectors return null so callers can safely use
 * an observed screen fallback. */
export class AgentResultReader {
  async read(session: AgentResultSession, maxBytes: number): Promise<NativeAgentResult | null> {
    if (session.remote || !session.connector || !session.dataHome) return null;
    const connector = RESULT_CONNECTORS[session.connector];
    if (!connector) return null;
    const sessionId =
      session.sessionId ??
      (await discoverCliSessionId({
        cli: session.agent,
        connector: session.connector,
        cwd: session.cwd,
        startedAtMs: session.startedAtMs,
        endedAtMs: session.endedAtMs,
        dataHome: session.dataHome,
      }));
    if (!sessionId) return null;
    if (!isSafeCliSessionId(sessionId)) return null;
    try {
      return await connector({
        ...session,
        connector: session.connector,
        dataHome: session.dataHome,
        sessionId,
        maxBytes,
      });
    } catch {
      return null;
    }
  }
}
