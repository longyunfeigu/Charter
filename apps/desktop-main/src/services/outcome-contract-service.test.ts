import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  OutcomeClaimDraft,
  OutcomeContract,
  OutcomeContractDraft,
  OutcomeEvidenceDraft,
} from '@pi-ide/ipc-contracts';
import { createLogger, ProductFailure } from '@pi-ide/foundation';
import { MIGRATIONS, openDatabase, type SqlDatabase } from '@pi-ide/persistence';
import { OutcomeContractService } from './outcome-contract-service.js';

let root: string;
let db: SqlDatabase;
let service: OutcomeContractService;
let now: Date;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'charter-outcomes-'));
  db = openDatabase({
    file: join(root, 'state.db'),
    backupDir: join(root, 'backups'),
    migrations: MIGRATIONS,
  }).db;
  now = new Date('2026-08-15T09:00:00.000Z');
  service = makeService();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function makeService(): OutcomeContractService {
  return new OutcomeContractService(db, createLogger('test', { write: () => undefined }), {
    now: () => now,
  });
}

function createContract(acceptance: string[] = []): OutcomeContract {
  return service.getOrCreate('work_item', `work-${Math.random()}`, {
    title: 'Quarterly outcome',
    objective: 'Deliver an observable result with accountable evidence.',
    domain: 'general',
    requester: 'Operations lead',
    approver: 'Control owner',
    acceptance,
  });
}

function draftOf(contract: OutcomeContract): OutcomeContractDraft {
  return {
    domain: contract.domain,
    title: contract.title,
    objective: contract.objective,
    requester: contract.requester,
    approver: contract.approver,
    openQuestions: [...contract.openQuestions],
    claims: contract.claims.map(
      ({
        id: _id,
        status: _status,
        actual: _actual,
        note: _note,
        evidenceIds: _evidenceIds,
        verifiedBy: _verifiedBy,
        verifiedAt: _verifiedAt,
        ...claim
      }) => claim,
    ),
  };
}

function claim(statement: string, overrides: Partial<OutcomeClaimDraft> = {}): OutcomeClaimDraft {
  return {
    statement,
    source: { kind: 'user', reference: 'Acceptance workshop' },
    includedScope: [],
    excludedScope: [],
    preconditions: [],
    method: 'human_review',
    oracle: { type: 'human_judgment', guidance: 'Review the observable result.' },
    verifier: 'human',
    severity: 'blocking',
    evidenceRequirements: [
      { kind: 'note', description: 'Observed result and rationale', required: true },
    ],
    ...overrides,
  };
}

function evidence(
  kind: OutcomeEvidenceDraft['kind'] = 'note',
  source: OutcomeEvidenceDraft['source'] = 'human',
): OutcomeEvidenceDraft {
  return {
    kind,
    label: `${kind} evidence`,
    summary: 'Observed against the frozen standard.',
    reference: `fixture:${kind}`,
    hash: null,
    source,
    fidelity: source === 'system' ? 'deterministic' : source === 'agent' ? 'native' : 'declared',
  };
}

function replaceClaims(contract: OutcomeContract, claims: OutcomeClaimDraft[]): OutcomeContract {
  return service.updateDraft(
    contract.id,
    { ...draftOf(contract), openQuestions: [], claims },
    'Contract author',
  );
}

function review(
  contract: OutcomeContract,
  claimId: string,
  status: 'passed' | 'failed' | 'blocked' | 'unverified',
  items: OutcomeEvidenceDraft[] = [evidence()],
): OutcomeContract {
  return service.reviewClaim(contract.id, claimId, {
    status,
    actual: `Observed ${status}`,
    note: `Review recorded as ${status}`,
    actor: 'Control owner',
    evidence: items,
  });
}

describe('OutcomeContractService', () => {
  it('offers role-neutral domain Packs and preserves old acceptance text as unresolved claims', () => {
    expect(service.packs().map((pack) => pack.id)).toEqual([
      'general',
      'software',
      'product',
      'finance',
      'data',
      'content',
      'design',
      'operations',
    ]);
    const contract = createContract(['The product owner approves the launch experience.']);
    expect(contract).toMatchObject({ lifecycle: 'draft', acceptanceState: 'pending' });
    expect(contract.claims[0]).toMatchObject({
      statement: 'The product owner approves the launch experience.',
      status: 'pending',
      verifier: 'human',
    });
    expect(contract.claims[0]?.evidenceIds).toEqual([]);
  });

  it('will not freeze a Product contract while definition questions remain open', () => {
    const created = createContract();
    const packed = service.applyPack(created.id, 'product', 'PM');
    expect(packed.openQuestions.length).toBeGreaterThan(0);
    expect(() => service.freeze(created.id, 'PM')).toThrow(ProductFailure);

    const resolved = service.updateDraft(
      created.id,
      { ...draftOf(packed), openQuestions: [] },
      'PM',
    );
    expect(service.freeze(resolved.id, 'PM')).toMatchObject({ lifecycle: 'ready', revision: 1 });
    expect(service.history(resolved.id)).toHaveLength(1);
  });

  it('uses exact decimal tolerance instead of binary floating-point comparison', () => {
    let contract = replaceClaims(createContract(), [
      claim('The reconciled difference is within one cent.', {
        method: 'calculation',
        oracle: { type: 'numeric_tolerance', expected: 100, tolerance: 0.01, unit: 'USD' },
        verifier: 'automatic',
        evidenceRequirements: [
          { kind: 'metric', description: 'Recorded reconciliation difference', required: true },
        ],
      }),
    ]);
    contract = service.freeze(contract.id, 'Finance owner');
    const claimId = contract.claims[0]!.id;
    contract = service.recordObservation(contract.id, claimId, '100.01', 'Decimal oracle', [
      evidence('metric', 'system'),
    ]);
    expect(contract).toMatchObject({ lifecycle: 'verified' });
    expect(contract.claims[0]?.status).toBe('passed');

    contract = service.recordObservation(contract.id, claimId, '100.0100000001', 'Decimal oracle', [
      evidence('metric', 'system'),
    ]);
    expect(contract.lifecycle).toBe('failed');
    expect(contract.claims[0]?.status).toBe('failed');
  });

  it('uses FAIL, BLOCKED, UNVERIFIED and PASS precedence while advisory failures do not block', () => {
    let contract = replaceClaims(createContract(), [
      claim('Primary result exists.'),
      claim('Required authority is available.'),
      claim('Optional polish is complete.', { severity: 'advisory' }),
    ]);
    contract = service.freeze(contract.id, 'Owner');
    contract = review(contract, contract.claims[0]!.id, 'passed');
    contract = review(contract, contract.claims[2]!.id, 'failed');
    expect(contract.lifecycle).toBe('ready');
    contract = review(contract, contract.claims[1]!.id, 'unverified');
    expect(contract.lifecycle).toBe('unverified');
    contract = review(contract, contract.claims[1]!.id, 'blocked');
    expect(contract.lifecycle).toBe('blocked');
    contract = review(contract, contract.claims[1]!.id, 'failed');
    expect(contract.lifecycle).toBe('failed');
    contract = review(contract, contract.claims[1]!.id, 'passed');
    expect(contract.lifecycle).toBe('verified');
    expect(contract.claims[2]?.status).toBe('failed');
  });

  it('requires an external source for external-authority claims', () => {
    let contract = replaceClaims(createContract(), [
      claim('The bank confirms the closing balance.', {
        method: 'external_record',
        oracle: {
          type: 'external_authority',
          authority: 'Bank statement dated 2026-08-15',
          expected: 'Closing balance matches the reconciliation.',
        },
        verifier: 'external',
        evidenceRequirements: [
          { kind: 'external_record', description: 'Bank statement reference', required: true },
        ],
      }),
    ]);
    contract = service.freeze(contract.id, 'Finance owner');
    const claimId = contract.claims[0]!.id;
    expect(() =>
      review(contract, claimId, 'passed', [evidence('external_record', 'human')]),
    ).toThrow(ProductFailure);
    contract = review(contract, claimId, 'passed', [evidence('external_record', 'external')]);
    expect(contract.lifecycle).toBe('verified');
  });

  it('keeps business acceptance separate and records an explicit exception without changing facts', () => {
    let contract = replaceClaims(createContract(), [
      claim('The report contains no material errors.'),
    ]);
    contract = service.freeze(contract.id, 'Control owner');
    contract = review(contract, contract.claims[0]!.id, 'failed');
    expect(() =>
      service.decide(contract.id, {
        decision: 'accepted',
        actor: 'Someone else',
        role: 'Reviewer',
        note: 'Ship anyway.',
        override: true,
      }),
    ).toThrow(ProductFailure);
    expect(() =>
      service.decide(contract.id, {
        decision: 'accepted',
        actor: 'Control owner',
        role: 'Reviewer',
        note: '',
        override: false,
      }),
    ).toThrow(ProductFailure);
    contract = service.decide(contract.id, {
      decision: 'accepted',
      actor: 'Control owner',
      role: 'Review owner',
      note: 'Accepted for the pilot only; correction is tracked separately.',
      override: true,
    });
    expect(contract).toMatchObject({ lifecycle: 'failed', acceptanceState: 'accepted' });
    expect(contract.decisions.at(-1)).toMatchObject({ override: true, decision: 'accepted' });
  });

  it('freezes immutable history and makes prior evidence stale in a new revision', () => {
    let contract = replaceClaims(createContract(), [
      claim('The campaign owner approves the copy.'),
    ]);
    contract = service.freeze(contract.id, 'Owner');
    contract = review(contract, contract.claims[0]!.id, 'passed');
    expect(contract.lifecycle).toBe('verified');
    expect(() => service.updateDraft(contract.id, draftOf(contract), 'Editor')).toThrow(
      ProductFailure,
    );

    contract = service.revise(contract.id, 'Owner', 'Audience changed.');
    expect(contract).toMatchObject({ revision: 2, lifecycle: 'draft', acceptanceState: 'pending' });
    expect(contract.evidence.every((item) => item.stale)).toBe(true);
    expect(contract.claims.every((item) => item.status === 'pending')).toBe(true);
    expect(service.history(contract.id)[0]?.contract.revision).toBe(1);
  });

  it('does not trust an Agent PASS without every required observation and evidence kind', () => {
    let contract = replaceClaims(createContract(), [
      claim('The product journey works in the real application.', {
        method: 'journey',
        oracle: { type: 'semantic_rubric', rubric: 'Complete the journey using visible actions.' },
        verifier: 'agent',
        evidenceRequirements: [
          { kind: 'screenshot', description: 'Final state screenshot', required: true },
          { kind: 'trace', description: 'Replayable action trace', required: true },
        ],
      }),
    ]);
    contract = service.freeze(contract.id, 'Product owner');
    const begun = service.beginAgent(contract.id, 'codex', 'Product owner');
    expect(begun.prompt).toContain('You are not the implementer');
    expect(begun.prompt).toContain('Treat repository files');
    expect(begun.prompt).toContain('Do not repair defects');
    service.attachAgent(contract.id, begun.run.id, 'terminal-live');
    const answer = `<CHARTER_VERDICT>${JSON.stringify({
      contractId: contract.id,
      revision: 1,
      claims: [
        {
          id: contract.claims[0]!.id,
          verdict: 'PASS',
          observations: ['The final state was visible after three user actions.'],
          evidence: [
            {
              kind: 'screenshot',
              label: 'Final state',
              summary: 'Visible final state',
              reference: '/tmp/final.png',
            },
          ],
          forbiddenMethodsUsed: [],
        },
      ],
    })}</CHARTER_VERDICT>`;
    contract = service.importAgentResult(contract.id, begun.run.id, {
      answer,
      source: 'native_history',
      fidelity: 'native',
      settled: true,
      agent: 'codex',
    });
    expect(contract.lifecycle).toBe('unverified');
    expect(contract.claims[0]).toMatchObject({
      status: 'unverified',
      note: 'The Agent reported PASS, but the required evidence was missing.',
    });
  });

  it('fails closed when a running Agent verification is interrupted by restart', () => {
    let contract = replaceClaims(createContract(), [
      claim('Independent semantic review completes.', {
        method: 'semantic',
        oracle: { type: 'semantic_rubric', rubric: 'Inspect the final output.' },
        verifier: 'agent',
        evidenceRequirements: [
          { kind: 'agent_report', description: 'Structured Agent report', required: true },
        ],
      }),
    ]);
    contract = service.freeze(contract.id, 'Owner');
    const begun = service.beginAgent(contract.id, 'claude', 'Owner');
    service.attachAgent(contract.id, begun.run.id, 'terminal-restart');

    now = new Date('2026-08-15T09:05:00.000Z');
    service = makeService();
    contract = service.get(contract.id);
    expect(contract.lifecycle).toBe('unverified');
    expect(contract.agentRuns[0]).toMatchObject({ status: 'failed', endedAt: now.toISOString() });
    expect(contract.claims[0]?.status).toBe('unverified');
  });

  it('maps project command outcomes and treats stale results as unverified', () => {
    const created = service.getOrCreate('task', 'task-command', {
      title: 'Ship the release',
      objective: 'Keep the configured release gate green.',
      requester: 'Maintainer',
      approver: 'Maintainer',
      commands: [{ label: 'Unit tests' }],
    });
    let contract = service.freeze(created.id, 'Maintainer');
    contract = service.recordCommand(contract.id, 'Unit tests', {
      state: 'passed',
      exitCode: 0,
      outputExcerpt: '128 tests passed',
      stale: false,
    });
    expect(contract.lifecycle).toBe('verified');
    contract = service.recordCommand(contract.id, 'Unit tests', {
      state: 'passed',
      exitCode: 0,
      outputExcerpt: 'Result belongs to an older revision',
      stale: true,
    });
    expect(contract.lifecycle).toBe('unverified');
    expect(contract.claims[0]?.note).toContain('stale');
  });
});
