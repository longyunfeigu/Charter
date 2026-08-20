import React, { useEffect, useMemo, useState } from 'react';
import type {
  OutcomeClaimDraft,
  OutcomeClaimStatus,
  OutcomeContract,
  OutcomeContractDraft,
  OutcomeDomain,
  OutcomeDomainPack,
  OutcomeEvidenceDraft,
  OutcomeEvidenceKind,
  OutcomeOracle,
  OutcomeSubjectKind,
  OutcomeVerifier,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { installedTerminalAgents, useAgentCatalogStore } from '../store/agentCatalogStore.js';
import { useTerminalStore } from './TerminalPanel.js';
import { Ic } from './home-icons.js';
import '../styles/outcome-contract.css';

const VERIFICATION_COPY: Record<OutcomeContract['lifecycle'], string> = {
  draft: 'Draft',
  ready: 'Ready to verify',
  verifying: 'Verifying',
  verified: 'Verified',
  failed: 'Failed',
  blocked: 'Blocked',
  unverified: 'Unverified',
};

const CLAIM_COPY: Record<OutcomeClaimStatus, string> = {
  pending: 'Pending',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  unverified: 'Unverified',
};

const EVIDENCE_KINDS: OutcomeEvidenceKind[] = [
  'note',
  'command_output',
  'screenshot',
  'trace',
  'log',
  'file',
  'link',
  'metric',
  'approval',
  'agent_report',
  'external_record',
];

function claimDraft(claim: OutcomeContract['claims'][number]): OutcomeClaimDraft {
  return {
    statement: claim.statement,
    source: claim.source,
    includedScope: claim.includedScope,
    excludedScope: claim.excludedScope,
    preconditions: claim.preconditions,
    method: claim.method,
    oracle: claim.oracle,
    verifier: claim.verifier,
    severity: claim.severity,
    evidenceRequirements: claim.evidenceRequirements,
  };
}

function asDraft(contract: OutcomeContract): OutcomeContractDraft {
  return {
    domain: contract.domain,
    title: contract.title,
    objective: contract.objective,
    requester: contract.requester,
    approver: contract.approver,
    openQuestions: [...contract.openQuestions],
    claims: contract.claims.map(claimDraft),
  };
}

function defaultOracle(verifier: OutcomeVerifier): {
  method: OutcomeClaimDraft['method'];
  oracle: OutcomeOracle;
  evidence: OutcomeEvidenceKind;
} {
  if (verifier === 'automatic') {
    return {
      method: 'state',
      oracle: { type: 'exact', expected: '' },
      evidence: 'metric',
    };
  }
  if (verifier === 'agent') {
    return {
      method: 'semantic',
      oracle: {
        type: 'semantic_rubric',
        rubric: 'Describe observable evidence for PASS and the conditions that mean FAIL.',
      },
      evidence: 'agent_report',
    };
  }
  if (verifier === 'external') {
    return {
      method: 'external_record',
      oracle: { type: 'external_authority', authority: '', expected: '' },
      evidence: 'external_record',
    };
  }
  return {
    method: 'human_review',
    oracle: { type: 'human_judgment', guidance: 'Describe what the decision owner should review.' },
    evidence: 'approval',
  };
}

function newClaim(): OutcomeClaimDraft {
  const setup = defaultOracle('human');
  return {
    statement: 'Describe the observable result that must be true.',
    source: { kind: 'user', reference: '' },
    includedScope: [],
    excludedScope: [],
    preconditions: [],
    method: setup.method,
    oracle: setup.oracle,
    verifier: 'human',
    severity: 'blocking',
    evidenceRequirements: [
      { kind: setup.evidence, description: 'Evidence supporting this decision', required: true },
    ],
  };
}

function oracleLabel(oracle: OutcomeOracle): string {
  if (oracle.type === 'command') return `Project check · ${oracle.commandLabel}`;
  if (oracle.type === 'exact') return `Exactly “${oracle.expected || '…'}”`;
  if (oracle.type === 'contains') return `Contains “${oracle.expected || '…'}”`;
  if (oracle.type === 'numeric_tolerance')
    return `${oracle.expected} ± ${oracle.tolerance}${oracle.unit ? ` ${oracle.unit}` : ''}`;
  if (oracle.type === 'checklist') return `${oracle.expected.length} required observations`;
  if (oracle.type === 'semantic_rubric') return 'Semantic rubric';
  if (oracle.type === 'visual_reference') return 'Visual reference and rubric';
  if (oracle.type === 'external_authority') return `Authority · ${oracle.authority || 'not named'}`;
  return 'Decision-owner judgment';
}

function sourceFidelity(source: OutcomeEvidenceDraft['source']): OutcomeEvidenceDraft['fidelity'] {
  return source === 'system' ? 'deterministic' : source === 'agent' ? 'native' : 'declared';
}

function EvidenceEditor({
  defaultKind,
  source,
  onChange,
}: {
  defaultKind: OutcomeEvidenceKind;
  source: OutcomeEvidenceDraft['source'];
  onChange: (value: OutcomeEvidenceDraft) => void;
}): React.JSX.Element {
  const [kind, setKind] = useState<OutcomeEvidenceKind>(defaultKind);
  const [label, setLabel] = useState('');
  const [summary, setSummary] = useState('');
  const [reference, setReference] = useState('');

  useEffect(() => {
    onChange({
      kind,
      label: label.trim() || 'Review evidence',
      summary,
      reference,
      hash: null,
      source,
      fidelity: sourceFidelity(source),
    });
  }, [kind, label, summary, reference, source]);

  return (
    <div className="outcome-evidence-editor">
      <select
        aria-label="Evidence type"
        value={kind}
        onChange={(event) => setKind(event.target.value as OutcomeEvidenceKind)}
      >
        {EVIDENCE_KINDS.map((item) => (
          <option key={item} value={item}>
            {item.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
      <input
        aria-label="Evidence label"
        placeholder="Evidence label"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
      />
      <input
        aria-label="Evidence reference"
        placeholder="File, URL, receipt or artifact reference"
        value={reference}
        onChange={(event) => setReference(event.target.value)}
      />
      <textarea
        aria-label="Evidence summary"
        placeholder="What was observed?"
        rows={2}
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
      />
    </div>
  );
}

function DraftOracleEditor({
  claim,
  onChange,
}: {
  claim: OutcomeClaimDraft;
  onChange: (claim: OutcomeClaimDraft) => void;
}): React.JSX.Element {
  const setOracle = (oracle: OutcomeOracle, method = claim.method): void =>
    onChange({ ...claim, oracle, method });
  const style = claim.oracle.type;
  const options =
    claim.verifier === 'automatic'
      ? [
          ['exact', 'Exact value'],
          ['contains', 'Contains text'],
          ['numeric_tolerance', 'Number within tolerance'],
          ['checklist', 'Required observations'],
        ]
      : claim.verifier === 'agent'
        ? [
            ['semantic_rubric', 'Semantic review'],
            ['visual_reference', 'Visual comparison'],
          ]
        : claim.verifier === 'external'
          ? [['external_authority', 'External authority']]
          : [['human_judgment', 'Decision-owner judgment']];

  const choose = (type: string): void => {
    if (type === 'exact') setOracle({ type: 'exact', expected: '' }, 'state');
    else if (type === 'contains') setOracle({ type: 'contains', expected: '' }, 'state');
    else if (type === 'numeric_tolerance')
      setOracle({ type: 'numeric_tolerance', expected: 0, tolerance: 0, unit: '' }, 'calculation');
    else if (type === 'checklist')
      setOracle({ type: 'checklist', expected: ['Required observation'] }, 'state');
    else if (type === 'semantic_rubric')
      setOracle(
        { type: 'semantic_rubric', rubric: 'Describe observable PASS and FAIL evidence.' },
        'semantic',
      );
    else if (type === 'visual_reference')
      setOracle(
        {
          type: 'visual_reference',
          reference: '',
          rubric: 'Describe layout, state, and quality expectations.',
        },
        'visual',
      );
    else if (type === 'external_authority')
      setOracle({ type: 'external_authority', authority: '', expected: '' }, 'external_record');
    else
      setOracle(
        { type: 'human_judgment', guidance: 'Describe what the decision owner should review.' },
        'human_review',
      );
  };
  const oracle = claim.oracle;

  return (
    <div className="outcome-oracle-editor">
      <label>
        <span>How will this be judged?</span>
        <select value={style} onChange={(event) => choose(event.target.value)}>
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {oracle.type === 'exact' || oracle.type === 'contains' ? (
        <label>
          <span>Expected value</span>
          <input
            value={oracle.expected}
            onChange={(event) => setOracle({ ...oracle, expected: event.target.value })}
          />
        </label>
      ) : oracle.type === 'numeric_tolerance' ? (
        <div className="outcome-oracle-number">
          <label>
            <span>Expected</span>
            <input
              type="number"
              value={oracle.expected}
              onChange={(event) => setOracle({ ...oracle, expected: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Tolerance</span>
            <input
              type="number"
              min="0"
              value={oracle.tolerance}
              onChange={(event) => setOracle({ ...oracle, tolerance: Number(event.target.value) })}
            />
          </label>
          <label>
            <span>Unit</span>
            <input
              value={oracle.unit}
              onChange={(event) => setOracle({ ...oracle, unit: event.target.value })}
            />
          </label>
        </div>
      ) : oracle.type === 'checklist' ? (
        <label>
          <span>Required observations · one per line</span>
          <textarea
            rows={3}
            value={oracle.expected.join('\n')}
            onChange={(event) =>
              setOracle({
                ...oracle,
                expected: event.target.value
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
      ) : oracle.type === 'semantic_rubric' ? (
        <label>
          <span>Observable rubric</span>
          <textarea
            rows={3}
            value={oracle.rubric}
            onChange={(event) => setOracle({ ...oracle, rubric: event.target.value })}
          />
        </label>
      ) : oracle.type === 'visual_reference' ? (
        <>
          <label>
            <span>Reference</span>
            <input
              placeholder="Design file, screenshot, or specification"
              value={oracle.reference}
              onChange={(event) => setOracle({ ...oracle, reference: event.target.value })}
            />
          </label>
          <label>
            <span>Visual rubric</span>
            <textarea
              rows={3}
              value={oracle.rubric}
              onChange={(event) => setOracle({ ...oracle, rubric: event.target.value })}
            />
          </label>
        </>
      ) : oracle.type === 'external_authority' ? (
        <>
          <label>
            <span>Source of truth</span>
            <input
              placeholder="ERP ledger, signed receipt, policy owner…"
              value={oracle.authority}
              onChange={(event) => setOracle({ ...oracle, authority: event.target.value })}
            />
          </label>
          <label>
            <span>Expected authoritative result</span>
            <textarea
              rows={2}
              value={oracle.expected}
              onChange={(event) => setOracle({ ...oracle, expected: event.target.value })}
            />
          </label>
        </>
      ) : oracle.type === 'human_judgment' ? (
        <label>
          <span>Decision guidance</span>
          <textarea
            rows={3}
            value={oracle.guidance}
            onChange={(event) => setOracle({ ...oracle, guidance: event.target.value })}
          />
        </label>
      ) : null}
    </div>
  );
}

function ClaimReview({
  contract,
  claim,
  onChanged,
}: {
  contract: OutcomeContract;
  claim: OutcomeContract['claims'][number];
  onChanged: (contract: OutcomeContract) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<Exclude<OutcomeClaimStatus, 'pending'>>('passed');
  const [actual, setActual] = useState('');
  const [note, setNote] = useState('');
  const [actor, setActor] = useState(contract.approver || 'You');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialKind =
    claim.evidenceRequirements.find((requirement) => requirement.required)?.kind ??
    (claim.verifier === 'external' ? 'external_record' : 'approval');
  const requirements = claim.evidenceRequirements.filter((requirement) => requirement.required);
  const evidenceSource = claim.verifier === 'external' ? 'external' : 'human';
  const [evidence, setEvidence] = useState<OutcomeEvidenceDraft[]>(() =>
    (requirements.length > 0 ? requirements : [{ kind: initialKind }]).map((requirement) => ({
      kind: requirement.kind,
      label: 'Review evidence',
      summary: '',
      reference: '',
      hash: null,
      source: evidenceSource,
      fidelity: 'declared',
    })),
  );

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await rpcResult('outcomes.reviewClaim', {
      contractId: contract.id,
      claimId: claim.id,
      status,
      actual,
      note,
      actor,
      evidence,
    });
    setBusy(false);
    if (!result.ok) setError(result.error.userMessage);
    else onChanged(result.data.contract);
  };

  return (
    <div className="outcome-review-form" data-testid={`outcome-review-${claim.id}`}>
      <div className="outcome-review-line">
        <select
          aria-label="Review result"
          value={status}
          onChange={(event) =>
            setStatus(event.target.value as Exclude<OutcomeClaimStatus, 'pending'>)
          }
        >
          <option value="passed">Pass</option>
          <option value="failed">Fail</option>
          <option value="blocked">Blocked</option>
          <option value="unverified">Insufficient evidence</option>
        </select>
        <input
          aria-label="Reviewer"
          value={actor}
          placeholder="Reviewer or authority"
          onChange={(event) => setActor(event.target.value)}
        />
      </div>
      <textarea
        aria-label="Observed result"
        rows={2}
        value={actual}
        placeholder="What actually happened?"
        onChange={(event) => setActual(event.target.value)}
      />
      <textarea
        aria-label="Review note"
        rows={2}
        value={note}
        placeholder="Decision rationale, exception, or blocker"
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="outcome-required-evidence">
        {(requirements.length > 0
          ? requirements
          : [{ kind: initialKind, description: 'Review evidence' }]
        ).map((requirement, index) => (
          <div key={`${requirement.kind}:${index}`}>
            <span>{requirement.description}</span>
            <EvidenceEditor
              defaultKind={requirement.kind}
              source={evidenceSource}
              onChange={(value) =>
                setEvidence((current) =>
                  current.map((item, candidate) => (candidate === index ? value : item)),
                )
              }
            />
          </div>
        ))}
      </div>
      {error ? <p className="outcome-inline-error">{error}</p> : null}
      <button
        className="btn primary"
        disabled={busy || !actor.trim()}
        onClick={() => void submit()}
      >
        {busy ? 'Recording…' : 'Record review'}
      </button>
    </div>
  );
}

function AutomaticObservation({
  contract,
  claim,
  onChanged,
}: {
  contract: OutcomeContract;
  claim: OutcomeContract['claims'][number];
  onChanged: (contract: OutcomeContract) => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const evidenceKind = claim.evidenceRequirements.find((item) => item.required)?.kind ?? 'metric';
  const supportingRequirements = claim.evidenceRequirements.filter(
    (item, index) => item.required && (item.kind !== evidenceKind || index > 0),
  );
  const [supportingEvidence, setSupportingEvidence] = useState<OutcomeEvidenceDraft[]>(() =>
    supportingRequirements.map((requirement) => ({
      kind: requirement.kind,
      label: 'Supporting evidence',
      summary: '',
      reference: '',
      hash: null,
      source: 'human',
      fidelity: 'declared',
    })),
  );

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await rpcResult('outcomes.observe', {
      contractId: contract.id,
      claimId: claim.id,
      value,
      actor: 'Charter deterministic oracle',
      evidence: [
        {
          kind: evidenceKind,
          label: 'Observed value',
          summary: value,
          reference: '',
          hash: null,
          source: 'system',
          fidelity: 'deterministic',
        },
        ...supportingEvidence,
      ],
    });
    setBusy(false);
    if (!result.ok) setError(result.error.userMessage);
    else onChanged(result.data.contract);
  };

  return (
    <div className="outcome-observation-form">
      <input
        aria-label="Observed value"
        value={value}
        placeholder="Enter the observed value"
        onChange={(event) => setValue(event.target.value)}
      />
      <button className="btn" disabled={busy || !value.trim()} onClick={() => void run()}>
        {busy ? 'Comparing…' : 'Compare'}
      </button>
      {supportingRequirements.length > 0 ? (
        <div className="outcome-required-evidence">
          {supportingRequirements.map((requirement, index) => (
            <div key={`${requirement.kind}:${index}`}>
              <span>{requirement.description}</span>
              <EvidenceEditor
                defaultKind={requirement.kind}
                source="human"
                onChange={(item) =>
                  setSupportingEvidence((current) =>
                    current.map((candidate, candidateIndex) =>
                      candidateIndex === index ? item : candidate,
                    ),
                  )
                }
              />
            </div>
          ))}
        </div>
      ) : null}
      {error ? <p className="outcome-inline-error">{error}</p> : null}
    </div>
  );
}

export function OutcomeContractPanel({
  subjectKind,
  subjectId,
  surface = 'session',
}: {
  subjectKind: OutcomeSubjectKind;
  subjectId: string;
  surface?: 'session' | 'work';
}): React.JSX.Element {
  const pushToast = useAppStore((state) => state.pushToast);
  const openTerminalSession = useAppStore((state) => state.openTerminalSession);
  const agents = useAgentCatalogStore((state) => state.agents);
  const [contract, setContract] = useState<OutcomeContract | null>(null);
  const [packs, setPacks] = useState<OutcomeDomainPack[]>([]);
  const [draft, setDraft] = useState<OutcomeContractDraft | null>(null);
  const [selectedPack, setSelectedPack] = useState<OutcomeDomain>('general');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState<string | null>(null);
  const [decisionActor, setDecisionActor] = useState('');
  const [decisionRole, setDecisionRole] = useState('Decision owner');
  const [decisionNote, setDecisionNote] = useState('');
  const [override, setOverride] = useState(false);

  const update = (next: OutcomeContract): void => {
    const previousApprover = contract?.approver ?? '';
    setContract(next);
    setDraft(asDraft(next));
    setSelectedPack(next.domain);
    setDecisionActor((current) =>
      !current.trim() || current === 'You' || current === previousApprover
        ? next.approver || 'You'
        : current,
    );
  };

  const load = async (): Promise<void> => {
    setBusy('load');
    setError(null);
    const [contractResult, packsResult] = await Promise.all([
      rpcResult('outcomes.get', { subjectKind, subjectId }),
      rpcResult('outcomes.packs', {}),
    ]);
    setBusy(null);
    if (!contractResult.ok) {
      setError(contractResult.error.userMessage);
      return;
    }
    if (packsResult.ok) setPacks(packsResult.data.packs);
    update(contractResult.data.contract);
  };

  useEffect(() => {
    useAgentCatalogStore.getState().init();
    void load();
  }, [subjectKind, subjectId]);

  useEffect(() => {
    const installed = agents.filter((agent) => agent.installed && agent.capabilities.terminal);
    if (!installed.some((agent) => agent.id === selectedAgent))
      setSelectedAgent(installed[0]?.id ?? '');
  }, [agents, selectedAgent]);

  const activeAgentRuns = contract?.agentRuns.filter((run) => run.status === 'running') ?? [];
  useEffect(() => {
    if (activeAgentRuns.length === 0 || !contract) return;
    const timer = window.setInterval(() => {
      for (const run of activeAgentRuns) {
        void rpcResult('outcomes.agent.collect', { contractId: contract.id, runId: run.id }).then(
          (result) => {
            if (result.ok && result.data.collected) {
              update(result.data.contract);
              pushToast('success', 'Independent Agent evidence was collected.');
            }
          },
        );
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [contract?.id, activeAgentRuns.map((run) => run.id).join('|')]);

  const saveDraft = async (): Promise<OutcomeContract | null> => {
    if (!contract || !draft) return null;
    setBusy('save');
    setError(null);
    const result = await rpcResult('outcomes.updateDraft', {
      contractId: contract.id,
      draft,
      actor: 'You',
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.error.userMessage);
      return null;
    }
    update(result.data.contract);
    return result.data.contract;
  };

  const applyPack = async (): Promise<void> => {
    if (!contract) return;
    const saved = await saveDraft();
    if (!saved) return;
    setBusy('pack');
    const result = await rpcResult('outcomes.applyPack', {
      contractId: saved.id,
      domain: selectedPack,
      actor: 'You',
    });
    setBusy(null);
    if (!result.ok) setError(result.error.userMessage);
    else update(result.data.contract);
  };

  const freeze = async (): Promise<void> => {
    const saved = await saveDraft();
    if (!saved) return;
    setBusy('freeze');
    const result = await rpcResult('outcomes.freeze', { contractId: saved.id, actor: 'You' });
    setBusy(null);
    if (!result.ok) setError(result.error.userMessage);
    else {
      update(result.data.contract);
      pushToast(
        'success',
        `Acceptance contract revision ${result.data.contract.revision} is frozen.`,
      );
    }
  };

  const runCommands = async (): Promise<void> => {
    if (!contract) return;
    setBusy('commands');
    setError(null);
    const result = await rpcResult('outcomes.runCommands', { contractId: contract.id });
    setBusy(null);
    if (!result.ok) setError(result.error.userMessage);
    else {
      update(result.data.contract);
      pushToast(
        result.data.ran > 0 ? 'success' : 'info',
        result.data.ran > 0
          ? `Recorded ${result.data.ran} project check${result.data.ran === 1 ? '' : 's'}.`
          : 'No linked project checks were available.',
      );
    }
  };

  const startAgent = async (): Promise<void> => {
    if (!contract || !selectedAgent) return;
    setBusy('agent');
    setError(null);
    const begun = await rpcResult('outcomes.agent.begin', {
      contractId: contract.id,
      agentId: selectedAgent,
      actor: 'You',
    });
    if (!begun.ok) {
      setBusy(null);
      setError(begun.error.userMessage);
      return;
    }
    const terminalId = await useTerminalStore.getState().create({
      launch: selectedAgent,
      initialPrompt: begun.data.prompt,
      context: subjectKind === 'task' ? { kind: 'task', taskId: subjectId } : { kind: 'focused' },
      reveal: false,
      title: `${selectedAgent} · independent acceptance`,
    });
    if (!terminalId) {
      await rpcResult('outcomes.agent.cancel', {
        contractId: contract.id,
        runId: begun.data.run.id,
        actor: 'Charter',
      });
      setBusy(null);
      setError('Charter could not create the independent Agent terminal.');
      return;
    }
    const attached = await rpcResult('outcomes.agent.attach', {
      contractId: contract.id,
      runId: begun.data.run.id,
      terminalId,
    });
    setBusy(null);
    if (!attached.ok) setError(attached.error.userMessage);
    else {
      update(attached.data.contract);
      pushToast(
        'success',
        'Independent Agent verification started. Its terminal is available here.',
      );
    }
  };

  const recordDecision = async (decision: 'accepted' | 'rejected'): Promise<void> => {
    if (!contract) return;
    setBusy(`decision:${decision}`);
    setError(null);
    const result = await rpcResult('outcomes.decide', {
      contractId: contract.id,
      decision,
      actor: decisionActor,
      role: decisionRole,
      note: decisionNote,
      override,
    });
    setBusy(null);
    if (!result.ok) setError(result.error.userMessage);
    else update(result.data.contract);
  };

  const automaticCommands =
    contract?.claims.filter((claim) => claim.oracle.type === 'command').length ?? 0;
  const agentClaims = contract?.claims.filter((claim) => claim.verifier === 'agent').length ?? 0;
  const blocking = contract?.claims.filter((claim) => claim.severity === 'blocking') ?? [];
  const passed = blocking.filter((claim) => claim.status === 'passed').length;
  const activePack = packs.find((pack) => pack.id === selectedPack);

  if (!contract || !draft) {
    return (
      <section
        className={`outcome-contract outcome-${surface}`}
        data-testid="outcome-contract-panel"
      >
        {error ? (
          <div className="outcome-error">{error}</div>
        ) : (
          <div className="outcome-loading">Preparing the acceptance contract…</div>
        )}
      </section>
    );
  }

  return (
    <section className={`outcome-contract outcome-${surface}`} data-testid="outcome-contract-panel">
      <header className="outcome-head">
        <div>
          <span className="outcome-eyebrow">OUTCOME CONTRACT · REVISION {contract.revision}</span>
          <h3>{contract.title}</h3>
          <p>Charter verifies evidence. The named decision owner accepts the business result.</p>
        </div>
        <div
          className="outcome-status-pair"
          aria-label={`Verification ${VERIFICATION_COPY[contract.lifecycle]}, acceptance ${contract.acceptanceState}`}
        >
          <span className={`outcome-status ${contract.lifecycle}`}>
            Verified · {VERIFICATION_COPY[contract.lifecycle]}
          </span>
          <span className={`outcome-status acceptance-${contract.acceptanceState}`}>
            Accepted · {contract.acceptanceState}
          </span>
        </div>
      </header>

      {error ? (
        <div className="outcome-error" role="alert">
          {error}
        </div>
      ) : null}

      {!contract.frozenAt ? (
        <div className="outcome-draft" data-testid="outcome-contract-draft">
          <div className="outcome-pack-picker">
            <label>
              <span>Start from a role-aware Pack</span>
              <select
                data-testid="outcome-pack-select"
                value={selectedPack}
                onChange={(event) => setSelectedPack(event.target.value as OutcomeDomain)}
              >
                {packs.map((pack) => (
                  <option key={pack.id} value={pack.id}>
                    {pack.name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <strong>{activePack?.audience}</strong>
              <p>{activePack?.description}</p>
            </div>
            <button
              className="btn"
              data-testid="outcome-apply-pack"
              disabled={busy !== null}
              onClick={() => void applyPack()}
            >
              {busy === 'pack' ? 'Applying…' : 'Apply Pack'}
            </button>
          </div>

          <div className="outcome-identity-grid">
            <label>
              <span>Requested by</span>
              <input
                data-testid="outcome-requester"
                value={draft.requester}
                placeholder="Person or accountable role"
                onChange={(event) => setDraft({ ...draft, requester: event.target.value })}
              />
            </label>
            <label>
              <span>Final decision owner</span>
              <input
                data-testid="outcome-approver"
                value={draft.approver}
                placeholder="Person or accountable role"
                onChange={(event) => setDraft({ ...draft, approver: event.target.value })}
              />
            </label>
          </div>
          <label className="outcome-objective">
            <span>Outcome</span>
            <textarea
              rows={3}
              value={draft.objective}
              onChange={(event) => setDraft({ ...draft, objective: event.target.value })}
            />
          </label>

          {draft.openQuestions.length > 0 ? (
            <div className="outcome-questions" data-testid="outcome-open-questions">
              <div>
                <strong>
                  {draft.openQuestions.length} definition question
                  {draft.openQuestions.length === 1 ? '' : 's'}
                </strong>
                <span>
                  Resolve these in the fields and criteria below, then mark each resolved.
                </span>
              </div>
              {draft.openQuestions.map((question, index) => (
                <div key={`${question}:${index}`}>
                  <span>{question}</span>
                  <button
                    aria-label="Mark question resolved"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        openQuestions: draft.openQuestions.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      })
                    }
                  >
                    Resolved
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="outcome-claim-list">
            {draft.claims.map((claim, index) => (
              <article
                className="outcome-claim-edit"
                data-testid={`outcome-draft-claim-${index}`}
                key={index}
              >
                <header>
                  <span>Criterion {index + 1}</span>
                  <button
                    aria-label="Remove criterion"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        claims: draft.claims.filter((_, candidate) => candidate !== index),
                      })
                    }
                  >
                    <Ic name="x" size={12} />
                  </button>
                </header>
                <textarea
                  aria-label={`Criterion ${index + 1}`}
                  rows={2}
                  value={claim.statement}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      claims: draft.claims.map((item, candidate) =>
                        candidate === index ? { ...item, statement: event.target.value } : item,
                      ),
                    })
                  }
                />
                <div className="outcome-claim-controls">
                  <label>
                    <span>Who verifies?</span>
                    <select
                      value={claim.verifier}
                      onChange={(event) => {
                        const verifier = event.target.value as OutcomeVerifier;
                        const setup = defaultOracle(verifier);
                        setDraft({
                          ...draft,
                          claims: draft.claims.map((item, candidate) =>
                            candidate === index
                              ? {
                                  ...item,
                                  verifier,
                                  method: setup.method,
                                  oracle: setup.oracle,
                                  evidenceRequirements: [
                                    {
                                      kind: setup.evidence,
                                      description: 'Evidence supporting this criterion',
                                      required: true,
                                    },
                                  ],
                                }
                              : item,
                          ),
                        });
                      }}
                    >
                      <option value="automatic">Charter · deterministic</option>
                      <option value="agent">Independent Agent</option>
                      <option value="human">Decision owner</option>
                      <option value="external">External authority</option>
                    </select>
                  </label>
                  <label>
                    <span>Impact</span>
                    <select
                      value={claim.severity}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          claims: draft.claims.map((item, candidate) =>
                            candidate === index
                              ? { ...item, severity: event.target.value as 'blocking' | 'advisory' }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="blocking">Blocks verification</option>
                      <option value="advisory">Advisory</option>
                    </select>
                  </label>
                  <label>
                    <span>Requirement source</span>
                    <input
                      value={claim.source.reference}
                      placeholder="Person, PRD, policy, ledger…"
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          claims: draft.claims.map((item, candidate) =>
                            candidate === index
                              ? {
                                  ...item,
                                  source: { ...item.source, reference: event.target.value },
                                }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
                <DraftOracleEditor
                  claim={claim}
                  onChange={(next) =>
                    setDraft({
                      ...draft,
                      claims: draft.claims.map((item, candidate) =>
                        candidate === index ? next : item,
                      ),
                    })
                  }
                />
                <div className="outcome-evidence-requirement">
                  <label>
                    <span>Required evidence</span>
                    <select
                      value={claim.evidenceRequirements[0]?.kind ?? 'note'}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          claims: draft.claims.map((item, candidate) =>
                            candidate === index
                              ? {
                                  ...item,
                                  evidenceRequirements: [
                                    {
                                      kind: event.target.value as OutcomeEvidenceKind,
                                      description:
                                        item.evidenceRequirements[0]?.description ||
                                        'Evidence supporting this criterion',
                                      required: true,
                                    },
                                  ],
                                }
                              : item,
                          ),
                        })
                      }
                    >
                      {EVIDENCE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {kind.replaceAll('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </article>
            ))}
          </div>

          <div className="outcome-draft-actions">
            <button
              className="btn"
              data-testid="outcome-add-claim"
              onClick={() => setDraft({ ...draft, claims: [...draft.claims, newClaim()] })}
            >
              <Ic name="plus" size={12} /> Add criterion
            </button>
            <span />
            <button className="btn" disabled={busy !== null} onClick={() => void saveDraft()}>
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </button>
            <button
              className="btn primary"
              data-testid="outcome-freeze"
              disabled={busy !== null}
              onClick={() => void freeze()}
            >
              {busy === 'freeze' ? 'Freezing…' : 'Freeze acceptance contract'}
            </button>
          </div>
        </div>
      ) : (
        <div className="outcome-frozen" data-testid="outcome-contract-frozen">
          <div className="outcome-scoreboard">
            <div>
              <strong>
                {passed}/{blocking.length}
              </strong>
              <span>blocking criteria passed</span>
            </div>
            <div>
              <strong>{contract.evidence.filter((item) => !item.stale).length}</strong>
              <span>current evidence items</span>
            </div>
            <div>
              <strong>{contract.agentRuns.length}</strong>
              <span>independent Agent runs</span>
            </div>
            <div>
              <strong>{contract.decisions.length}</strong>
              <span>business decisions</span>
            </div>
          </div>

          <div className="outcome-runbar">
            {automaticCommands > 0 ? (
              <button
                className="btn"
                data-testid="outcome-run-commands"
                disabled={busy !== null}
                onClick={() => void runCommands()}
              >
                <Ic name="play" size={12} />{' '}
                {busy === 'commands'
                  ? 'Running project checks…'
                  : `Run ${automaticCommands} project check${automaticCommands === 1 ? '' : 's'}`}
              </button>
            ) : null}
            {agentClaims > 0 ? (
              <>
                <select
                  aria-label="Independent Agent"
                  value={selectedAgent}
                  onChange={(event) => setSelectedAgent(event.target.value)}
                >
                  {installedTerminalAgents().map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.displayName}
                    </option>
                  ))}
                </select>
                <button
                  className="btn"
                  data-testid="outcome-start-agent"
                  disabled={busy !== null || !selectedAgent || activeAgentRuns.length > 0}
                  onClick={() => void startAgent()}
                >
                  <Ic name="bot" size={12} />{' '}
                  {busy === 'agent' ? 'Starting…' : 'Run independent Agent'}
                </button>
              </>
            ) : null}
            <span />
            <button
              className="btn"
              onClick={async () => {
                const result = await rpcResult('outcomes.export', { contractId: contract.id });
                if (result.ok && result.data.markdownPath)
                  pushToast('success', 'Acceptance report exported as Markdown and JSON.');
                else if (!result.ok) setError(result.error.userMessage);
              }}
            >
              Export
            </button>
            <button
              className="btn"
              onClick={async () => {
                const result = await rpcResult('outcomes.revise', {
                  contractId: contract.id,
                  actor: 'You',
                  reason: 'Acceptance standard updated.',
                });
                if (result.ok) update(result.data.contract);
                else setError(result.error.userMessage);
              }}
            >
              New revision
            </button>
          </div>

          {contract.agentRuns.length > 0 ? (
            <div className="outcome-agent-runs">
              {contract.agentRuns
                .slice()
                .reverse()
                .map((run) => (
                  <div key={run.id} className={`outcome-agent-run ${run.status}`}>
                    <span>
                      <Ic name="bot" size={13} />
                    </span>
                    <div>
                      <strong>
                        {run.agentId} · {run.status.replaceAll('_', ' ')}
                      </strong>
                      <small>{run.message}</small>
                    </div>
                    {run.terminalId ? (
                      <button onClick={() => openTerminalSession(run.terminalId!)}>
                        Open terminal
                      </button>
                    ) : null}
                    {run.status === 'running' ? (
                      <button
                        onClick={async () => {
                          const result = await rpcResult('outcomes.agent.collect', {
                            contractId: contract.id,
                            runId: run.id,
                          });
                          if (result.ok) update(result.data.contract);
                          else setError(result.error.userMessage);
                        }}
                      >
                        Collect now
                      </button>
                    ) : null}
                  </div>
                ))}
            </div>
          ) : null}

          <div className="outcome-claim-list">
            {contract.claims.map((claim, index) => (
              <article
                className={`outcome-claim result-${claim.status}`}
                data-testid={`outcome-claim-${claim.id}`}
                key={claim.id}
              >
                <header>
                  <span className={`outcome-claim-state ${claim.status}`}>
                    {CLAIM_COPY[claim.status]}
                  </span>
                  <strong>
                    {index + 1}. {claim.statement}
                  </strong>
                  <em>{claim.severity}</em>
                </header>
                <div className="outcome-claim-meta">
                  <span>
                    {claim.verifier === 'automatic'
                      ? 'Charter deterministic'
                      : claim.verifier === 'agent'
                        ? 'Independent Agent'
                        : claim.verifier === 'external'
                          ? 'External authority'
                          : 'Decision owner'}
                  </span>
                  <span>{oracleLabel(claim.oracle)}</span>
                  <span>{claim.evidenceIds.length} evidence</span>
                </div>
                {claim.actual ? (
                  <p className="outcome-actual">
                    <b>Observed</b>
                    {claim.actual}
                  </p>
                ) : null}
                {claim.note ? <p className="outcome-note">{claim.note}</p> : null}
                <details>
                  <summary>Contract and evidence requirements</summary>
                  <dl>
                    <div>
                      <dt>Source</dt>
                      <dd>
                        {claim.source.kind} · {claim.source.reference || 'not named'}
                      </dd>
                    </div>
                    <div>
                      <dt>Required evidence</dt>
                      <dd>
                        {claim.evidenceRequirements
                          .map((item) => item.kind.replaceAll('_', ' '))
                          .join(', ') || 'None'}
                      </dd>
                    </div>
                    <div>
                      <dt>Verified by</dt>
                      <dd>{claim.verifiedBy || 'Not yet'}</dd>
                    </div>
                  </dl>
                </details>
                {claim.verifier === 'automatic' && claim.oracle.type !== 'command' ? (
                  <AutomaticObservation contract={contract} claim={claim} onChanged={update} />
                ) : claim.verifier === 'human' || claim.verifier === 'external' ? (
                  <ClaimReview contract={contract} claim={claim} onChanged={update} />
                ) : null}
              </article>
            ))}
          </div>

          <section className="outcome-decision" data-testid="outcome-decision">
            <div>
              <span className="outcome-eyebrow">BUSINESS DECISION</span>
              <h4>
                {contract.lifecycle === 'verified'
                  ? 'Evidence is verified. The result still needs acceptance.'
                  : `Evidence is ${VERIFICATION_COPY[contract.lifecycle].toLowerCase()}.`}
              </h4>
              <p>
                Accepting with missing or failed evidence records an explicit exception; it never
                changes the verification facts.
              </p>
            </div>
            <div className="outcome-decision-fields">
              <input
                aria-label="Decision actor"
                value={decisionActor}
                placeholder="Decision owner"
                onChange={(event) => setDecisionActor(event.target.value)}
              />
              <input
                aria-label="Decision role"
                value={decisionRole}
                placeholder="Role"
                onChange={(event) => setDecisionRole(event.target.value)}
              />
              <textarea
                aria-label="Decision rationale"
                rows={2}
                value={decisionNote}
                placeholder="Decision rationale or exception"
                onChange={(event) => setDecisionNote(event.target.value)}
              />
              {contract.lifecycle !== 'verified' ? (
                <label className="outcome-override">
                  <input
                    type="checkbox"
                    checked={override}
                    onChange={(event) => setOverride(event.target.checked)}
                  />
                  Accept with a documented exception. Verification remains {contract.lifecycle}.
                </label>
              ) : null}
            </div>
            <div className="outcome-decision-actions">
              <button
                className="btn"
                disabled={busy !== null || !decisionActor.trim()}
                onClick={() => void recordDecision('rejected')}
              >
                Request changes / reject
              </button>
              <button
                className="btn primary"
                data-testid="outcome-accept"
                disabled={
                  busy !== null ||
                  !decisionActor.trim() ||
                  (contract.lifecycle !== 'verified' && (!override || !decisionNote.trim()))
                }
                onClick={() => void recordDecision('accepted')}
              >
                {contract.lifecycle === 'verified' ? 'Accept result' : 'Accept with exception'}
              </button>
            </div>
          </section>

          {contract.evidence.length > 0 ? (
            <details className="outcome-ledger">
              <summary>Evidence ledger · {contract.evidence.length}</summary>
              {contract.evidence
                .slice()
                .reverse()
                .map((item) => (
                  <div key={item.id} className={item.stale ? 'stale' : ''}>
                    <span>{item.kind.replaceAll('_', ' ')}</span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{item.summary || item.reference || 'No detail'}</small>
                    </div>
                    <em>
                      {item.fidelity}
                      {item.stale ? ' · stale' : ''}
                    </em>
                  </div>
                ))}
            </details>
          ) : null}

          <details className="outcome-ledger">
            <summary>Audit trail · {contract.audit.length}</summary>
            {contract.audit
              .slice()
              .reverse()
              .map((event) => (
                <div key={event.id}>
                  <span>{event.type}</span>
                  <div>
                    <strong>{event.actor}</strong>
                    <small>{event.detail}</small>
                  </div>
                  <em>{new Date(event.at).toLocaleString()}</em>
                </div>
              ))}
          </details>
        </div>
      )}
    </section>
  );
}
