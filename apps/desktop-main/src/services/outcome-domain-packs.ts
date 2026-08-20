import {
  OutcomeDomainPackSchema,
  type OutcomeClaimDraft,
  type OutcomeDomain,
  type OutcomeDomainPack,
} from '@pi-ide/ipc-contracts';

const requirement = (
  kind:
    | 'note'
    | 'command_output'
    | 'screenshot'
    | 'trace'
    | 'log'
    | 'file'
    | 'link'
    | 'metric'
    | 'approval'
    | 'agent_report'
    | 'external_record',
  description: string,
  required = true,
) => ({ kind, description, required });

const claim = (
  value: OutcomeClaimDraft & { templateId: string; optional?: boolean },
): OutcomeDomainPack['recommendedClaims'][number] => ({
  ...value,
  optional: value.optional ?? false,
});

const source = (reference: string) => ({
  kind: 'domain_pack' as const,
  reference,
});

const PACKS: OutcomeDomainPack[] = [
  {
    id: 'general',
    name: 'General',
    audience: 'Any role or mixed-discipline work',
    description:
      'A neutral contract that keeps the requested outcome, evidence, and final owner explicit.',
    questions: [
      'What observable result would make this work complete?',
      'Which source or person has final authority when evidence conflicts?',
      'What must not change or happen as a side effect?',
      'Who is allowed to accept the result?',
    ],
    authorityGuidance:
      'Name the source of truth or decision owner. Charter can verify evidence; it cannot invent business authority.',
    recommendedClaims: [
      claim({
        templateId: 'general-outcome',
        statement: 'The requested outcome is complete within the agreed scope.',
        source: source('General Pack · outcome'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'human_review',
        oracle: {
          type: 'human_judgment',
          guidance:
            'Compare the delivered result with the agreed outcome and documented exclusions.',
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [requirement('note', 'A concise completion summary')],
      }),
    ],
  },
  {
    id: 'software',
    name: 'Software',
    audience: 'Developers, maintainers, QA and technical product teams',
    description:
      'Combines deterministic checks, real user paths, regression evidence, and maintainer acceptance.',
    questions: [
      'What exact user path must work?',
      'Which failure or recovery path is blocking?',
      'Which commands are the project source of truth?',
      'Which viewport, platform or environment must be covered?',
    ],
    authorityGuidance:
      'Existing project tests decide deterministic claims; a maintainer decides whether the verified change is accepted.',
    recommendedClaims: [
      claim({
        templateId: 'software-user-path',
        statement: 'A user can complete the primary workflow in the real application.',
        source: source('Software Pack · user path'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Use an isolated test profile and a known initial state.'],
        method: 'journey',
        oracle: {
          type: 'semantic_rubric',
          rubric:
            'Use only visible user actions. Report each action and the observed state. Do not mutate application state through JavaScript, storage, or direct database writes.',
        },
        verifier: 'agent',
        severity: 'blocking',
        evidenceRequirements: [
          requirement('screenshot', 'Before and after screenshots'),
          requirement('trace', 'A replayable interaction trace'),
        ],
      }),
      claim({
        templateId: 'software-errors',
        statement:
          'The primary workflow produces no framework overlay, page error, or unexpected console error.',
        source: source('Software Pack · runtime health'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'state',
        oracle: {
          type: 'checklist',
          expected: ['No framework overlay', 'No page error', 'No unexpected console error'],
        },
        verifier: 'agent',
        severity: 'blocking',
        evidenceRequirements: [requirement('log', 'Captured console and page errors')],
      }),
      claim({
        templateId: 'software-narrow',
        statement: 'The primary workflow remains usable at the agreed narrow viewport.',
        source: source('Software Pack · responsive behavior'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Record the target narrow viewport before freezing.'],
        method: 'visual',
        oracle: {
          type: 'visual_reference',
          reference: '',
          rubric:
            'No page-level horizontal overflow, clipped primary action, overlapping controls, or unreadable content.',
        },
        verifier: 'agent',
        severity: 'advisory',
        evidenceRequirements: [requirement('screenshot', 'Narrow viewport screenshot')],
      }),
    ],
  },
  {
    id: 'product',
    name: 'Product',
    audience: 'Product managers, founders and customer-experience owners',
    description:
      'Turns a product outcome into user journeys, measurable behavior, edge states, and a human release decision.',
    questions: [
      'Which user segment and starting state are in scope?',
      'What is the successful end state?',
      'Which loading, empty, error or permission state must be covered?',
      'What metric or event proves the intended product behavior?',
      'Which qualities remain a product-owner judgment?',
    ],
    authorityGuidance:
      'Runtime state and analytics are evidence; the named product owner remains the authority for product quality and release acceptance.',
    recommendedClaims: [
      claim({
        templateId: 'product-journey',
        statement: 'The target user can complete the core journey from the agreed starting state.',
        source: source('Product Pack · core journey'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Define the target user and initial state.'],
        method: 'journey',
        oracle: {
          type: 'semantic_rubric',
          rubric:
            'Execute the journey as a user, count material actions, and verify the observable final state.',
        },
        verifier: 'agent',
        severity: 'blocking',
        evidenceRequirements: [
          requirement('trace', 'User journey trace'),
          requirement('screenshot', 'Final state screenshot'),
        ],
      }),
      claim({
        templateId: 'product-edge-states',
        statement:
          'The agreed loading, empty, error and recovery states are understandable and actionable.',
        source: source('Product Pack · edge states'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['List which edge states are in scope.'],
        method: 'semantic',
        oracle: {
          type: 'semantic_rubric',
          rubric:
            'For each in-scope state, verify visible feedback, a clear next action, and a recoverable path.',
        },
        verifier: 'agent',
        severity: 'blocking',
        evidenceRequirements: [requirement('screenshot', 'One screenshot for each required state')],
      }),
      claim({
        templateId: 'product-owner-quality',
        statement: 'The result is ready for its intended audience and release context.',
        source: source('Product Pack · owner decision'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'human_review',
        oracle: {
          type: 'human_judgment',
          guidance:
            'Review usability, wording, positioning, trade-offs, and release readiness that cannot be reduced to deterministic facts.',
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [requirement('approval', 'Product owner decision with rationale')],
      }),
    ],
  },
  {
    id: 'finance',
    name: 'Finance',
    audience: 'Finance, accounting, reconciliation and control owners',
    description:
      'Makes period, entity, currency, source of truth, tolerance, traceability, and approval explicit.',
    questions: [
      'Which entity, accounting period and currency are in scope?',
      'Which ledger or system is the authoritative source?',
      'What is the permitted numeric tolerance and rounding rule?',
      'Must identifiers be unique and must every row have a supporting document?',
      'Who performed the work and who independently approves it?',
    ],
    authorityGuidance:
      'A named ledger or signed external record is authoritative. Automated reconciliation does not replace the accountable finance approver.',
    recommendedClaims: [
      claim({
        templateId: 'finance-authority',
        statement:
          'The authoritative balance, period, entity and currency are identified and available.',
        source: source('Finance Pack · authority'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'external_record',
        oracle: {
          type: 'external_authority',
          authority: 'Set the ledger or system of record before freezing.',
          expected: 'A complete, period-matched authoritative record is available.',
        },
        verifier: 'external',
        severity: 'blocking',
        evidenceRequirements: [
          requirement(
            'external_record',
            'Timestamped authoritative export, receipt, or query reference',
          ),
        ],
      }),
      claim({
        templateId: 'finance-reconciliation',
        statement:
          'The detail reconciles to the authoritative balance within the approved tolerance.',
        source: source('Finance Pack · reconciliation'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Define period, currency, source of truth, tolerance, and rounding rule.'],
        method: 'calculation',
        oracle: {
          type: 'human_judgment',
          guidance:
            'Review a deterministic reconciliation that shows both totals, signed difference, tolerance, exclusions, and exact source references.',
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [
          requirement('metric', 'Reconciliation totals and signed difference'),
          requirement('file', 'Exception detail'),
        ],
      }),
      claim({
        templateId: 'finance-traceability',
        statement: 'Every material exception is traceable to its source record and disposition.',
        source: source('Finance Pack · traceability'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'state',
        oracle: {
          type: 'checklist',
          expected: ['Source record identified', 'Difference explained', 'Disposition recorded'],
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [requirement('file', 'Exception list with source references')],
      }),
      claim({
        templateId: 'finance-approval',
        statement: 'An authorized reviewer independent of the performer approves the result.',
        source: source('Finance Pack · segregation of duties'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Name the performer and approver.'],
        method: 'human_review',
        oracle: {
          type: 'human_judgment',
          guidance: 'Confirm evidence, exceptions, and segregation of duties before approval.',
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [requirement('approval', 'Named approver, timestamp, and rationale')],
      }),
    ],
  },
  {
    id: 'data',
    name: 'Data',
    audience: 'Analysts, data owners and reporting teams',
    description:
      'Covers completeness, uniqueness, validity, freshness, lineage, and business-definition agreement.',
    questions: [
      'What dataset snapshot and timezone are in scope?',
      'Which fields must be complete and unique?',
      'What freshness or completeness threshold is required?',
      'Which metric definition is authoritative?',
    ],
    authorityGuidance:
      'Bind every result to an immutable input hash and the approved metric definition.',
    recommendedClaims: [
      claim({
        templateId: 'data-quality',
        statement: 'The dataset meets the agreed completeness, uniqueness and validity rules.',
        source: source('Data Pack · quality'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Record required fields, keys, thresholds, and input hash.'],
        method: 'calculation',
        oracle: {
          type: 'checklist',
          expected: [
            'Completeness threshold met',
            'Unique keys contain no duplicates',
            'Field validity rules met',
          ],
        },
        verifier: 'automatic',
        severity: 'blocking',
        evidenceRequirements: [
          requirement('metric', 'Row counts, null rates, duplicate counts, and violations'),
          requirement('file', 'Input snapshot hash'),
        ],
      }),
      claim({
        templateId: 'data-definition',
        statement: 'The output uses the approved business definition and source lineage.',
        source: source('Data Pack · meaning'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'external_record',
        oracle: {
          type: 'external_authority',
          authority: 'Named data owner or metric catalog',
          expected: 'Definition and lineage match the approved source.',
        },
        verifier: 'external',
        severity: 'blocking',
        evidenceRequirements: [requirement('link', 'Metric definition or data-catalog reference')],
      }),
    ],
  },
  {
    id: 'content',
    name: 'Content',
    audience: 'Writers, editors, marketing and communications teams',
    description:
      'Separates factual support, brief coverage, policy constraints, and subjective editorial acceptance.',
    questions: [
      'Which brief requirements are blocking?',
      'Which source is authoritative for each verifiable fact?',
      'Which brand, legal or channel rules apply?',
      'Who makes the final editorial judgment?',
    ],
    authorityGuidance:
      'Sources establish facts; the named editor owns tone, taste, and publication acceptance.',
    recommendedClaims: [
      claim({
        templateId: 'content-brief',
        statement:
          'The deliverable covers every blocking requirement in the brief without unsupported additions.',
        source: source('Content Pack · brief coverage'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'semantic',
        oracle: {
          type: 'semantic_rubric',
          rubric:
            'Map each blocking brief requirement to exact supporting content; list omissions and unsupported claims separately.',
        },
        verifier: 'agent',
        severity: 'blocking',
        evidenceRequirements: [requirement('agent_report', 'Requirement-to-content mapping')],
      }),
      claim({
        templateId: 'content-facts',
        statement: 'Every material factual claim is supported by the designated authority.',
        source: source('Content Pack · factual support'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Identify authoritative sources.'],
        method: 'external_record',
        oracle: {
          type: 'external_authority',
          authority: 'Designated source set',
          expected: 'Each material factual claim has a direct supporting source.',
        },
        verifier: 'external',
        severity: 'blocking',
        evidenceRequirements: [requirement('link', 'Claim-level source references')],
      }),
      claim({
        templateId: 'content-editorial',
        statement:
          'The content is acceptable for the intended audience, brand and publication context.',
        source: source('Content Pack · editorial acceptance'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'human_review',
        oracle: {
          type: 'human_judgment',
          guidance: 'Judge clarity, tone, sensitivity, brand fit, and publication risk.',
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [requirement('approval', 'Editor approval and rationale')],
      }),
    ],
  },
  {
    id: 'design',
    name: 'Design',
    audience: 'Product designers, design engineers and brand owners',
    description:
      'Combines reference comparison, responsive behavior, accessibility evidence, and human design judgment.',
    questions: [
      'Which design or brand reference is authoritative?',
      'Which states and viewport sizes must be reviewed?',
      'Which accessibility requirements are blocking?',
      'Who owns final visual acceptance?',
    ],
    authorityGuidance:
      'Automated and Agent checks identify observable defects; a design owner decides aesthetic acceptance.',
    recommendedClaims: [
      claim({
        templateId: 'design-reference',
        statement:
          'The rendered result matches the agreed layout, hierarchy, states and responsive intent.',
        source: source('Design Pack · reference comparison'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Attach or name the authoritative reference and required viewports.'],
        method: 'visual',
        oracle: {
          type: 'visual_reference',
          reference: '',
          rubric:
            'Compare structure, spacing, hierarchy, clipping, state coverage and responsive adaptation; do not decide only from pixel similarity.',
        },
        verifier: 'agent',
        severity: 'blocking',
        evidenceRequirements: [
          requirement('screenshot', 'Comparable screenshots for each required state and viewport'),
        ],
      }),
      claim({
        templateId: 'design-owner',
        statement: 'The result meets the intended visual quality and brand character.',
        source: source('Design Pack · owner judgment'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'human_review',
        oracle: {
          type: 'human_judgment',
          guidance:
            'Judge hierarchy, rhythm, coherence, brand character, and overall product quality.',
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [requirement('approval', 'Design-owner decision')],
      }),
    ],
  },
  {
    id: 'operations',
    name: 'Operations',
    audience: 'Operations, launch, campaign and partner teams',
    description:
      'Makes the runbook, target population, irreversible actions, receipts, exceptions, and owner decision explicit.',
    questions: [
      'What runbook and target population are in scope?',
      'Which external action is irreversible or costly?',
      'What receipt proves execution?',
      'How should partial success and exceptions be handled?',
      'Who authorizes the external action and accepts the outcome?',
    ],
    authorityGuidance:
      'External receipts prove execution; the operation owner decides whether partial results and exceptions are acceptable.',
    recommendedClaims: [
      claim({
        templateId: 'operations-runbook',
        statement:
          'The operation followed the approved runbook for the complete target population.',
        source: source('Operations Pack · runbook'),
        includedScope: [],
        excludedScope: [],
        preconditions: ['Attach the approved runbook and freeze the target population.'],
        method: 'state',
        oracle: {
          type: 'checklist',
          expected: [
            'Approved runbook used',
            'Target population frozen',
            'Each step recorded',
            'Exceptions listed',
          ],
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [requirement('file', 'Run record and exception list')],
      }),
      claim({
        templateId: 'operations-receipt',
        statement:
          'The external system confirms the intended action for the correct target and scope.',
        source: source('Operations Pack · receipt'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'external_record',
        oracle: {
          type: 'external_authority',
          authority: 'Target external system',
          expected: 'Timestamped receipt matches target, scope, and action.',
        },
        verifier: 'external',
        severity: 'blocking',
        evidenceRequirements: [
          requirement('external_record', 'External receipt or status reference'),
        ],
      }),
      claim({
        templateId: 'operations-owner',
        statement: 'The owner has reviewed exceptions and accepts the operational result.',
        source: source('Operations Pack · owner decision'),
        includedScope: [],
        excludedScope: [],
        preconditions: [],
        method: 'human_review',
        oracle: {
          type: 'human_judgment',
          guidance:
            'Review completion, partial failures, downstream impact, and follow-up ownership.',
        },
        verifier: 'human',
        severity: 'blocking',
        evidenceRequirements: [
          requirement('approval', 'Operations owner decision and exception rationale'),
        ],
      }),
    ],
  },
];

export const OUTCOME_DOMAIN_PACKS = Object.freeze(
  PACKS.map((pack) => OutcomeDomainPackSchema.parse(pack)),
);

export function outcomeDomainPack(domain: OutcomeDomain): OutcomeDomainPack {
  return OUTCOME_DOMAIN_PACKS.find((pack) => pack.id === domain) ?? OUTCOME_DOMAIN_PACKS[0]!;
}
