# SSH / SFTP forward-test contract

## Historical evidence

- Previous Skill output:
  `docs/design/mock-html-skill-showcase/sftp-transfer.html`
- Previous recorded brief:
  “保持双栏文件管理习惯，同时让目标路径、覆盖冲突、进度和失败恢复始终清楚。”
- Historical chat transcript is unavailable in the ADE search index. This benchmark uses the repository artifact and
  its recorded evaluation rather than presenting repository evidence as chat evidence.

## Reconstructed product frame

- **User:** a developer deploying a Charter desktop build to an already-connected Linux host.
- **Situation:** two local release files are selected; one filename already exists remotely.
- **Job:** confirm exactly what will be written where, choose a conflict policy, start the upload, and recover from a
  partial connection failure without restarting completed work.
- **Entry trigger:** select local files in the SFTP file workspace.
- **Promised outcome:** the exact batch is present at the intended remote path, with a readable completion receipt.
- **Primary object:** transfer batch `tx_01KSSH`.
- **Danger:** replacing an existing remote build or mistaking the local and remote direction.
- **Edge state:** the large file conflicts; the smaller file fails after the large file completed.

## Frozen comparison constants

| Field | Value |
| --- | --- |
| Host | `prod-api-01` |
| Endpoint | `root@10.0.3.46` |
| Connection | SFTP · 38 ms · host key verified |
| Local path | `~/Projects/charter` |
| Remote path | `/home/deploy/releases` |
| File 1 | `charter-1.0.0.dmg` · 98.2 MB |
| File 2 | `release-notes.md` · 4.1 KB |
| Conflict | remote `charter-1.0.0.dmg` · 91.7 MB |
| Default policy | Keep both |
| Viewports | 1440 × 900 and 760 × 820 |

## Facts, assumptions, decisions

- **Fact:** the repository uses a dual-pane local/remote SFTP model and a persistent transfer center.
- **Fact:** the historical mock already modeled conflict preflight and resumable retry.
- **Assumption:** the target path is writable and the connection has already passed host-key verification.
- **Assumption:** keep-both naming is computed by the backend and never overwrites the existing file.
- **Decision:** the prototype demonstrates one batch rather than unrelated historical transfers so the causal state is
  inspectable.
- **Decision:** the completion receipt is a prototype state, not a claim about current backend persistence.

## Impact map

| Surface | Shared object/state | Causal boundary | Legacy decision | Mock? | Reason |
| --- | --- | --- | --- | --- | --- |
| File workspace | selected files, source, destination | Entry / identity | Preserve dual-pane recognition; correct weak direction semantics | Yes | Defines the batch |
| Preflight sheet | same batch, conflict, policy | Consequence / invariant | Preserve lightweight confirmation; strengthen exact write result | Yes | Prevents unsafe overwrite |
| Transfer ledger | same batch, per-file progress, receipt | Propagation / recovery | Preserve persistent activity; remove unrelated queue clutter | Yes | Proves partial failure and resume |
| Host manager | host identity | Navigation | Preserve | No | Host selection is already complete |
| Port forwards | connection | Adjacent tool | Preserve | No | No causal role in file transfer |
| Remote terminal | host identity | Adjacent tool | Preserve | No | Does not close this upload intent |

## Behavioral directions

### Conventional

Classic dual pane with upload arrow and modal confirmation.

- Benefit: lowest learning cost.
- Cost: selection, destination, and recovery become visually separated.
- Failure mode: the arrow communicates movement but not the exact write consequence.

### Task-first — chosen

Keep the dual pane, but turn selected files into a visible transfer manifest and route spine. The primary action names
the destination. Preflight resolves only material risks. One ledger then owns progress, failure, retry, and receipt.

- Benefit: familiar browsing plus explicit causality.
- Cost: slightly more persistent status chrome.
- Failure mode: could become deployment-specific if the manifest overwhelms ordinary file browsing.

### Queue-first

Stage files into a transfer cart and execute later.

- Benefit: strong batch review.
- Cost: adds a new staging mental model and one more step for the common immediate upload.
- Failure mode: feels like a job scheduler instead of a file workspace.

## Frozen behavior contract

1. Initial state names local source, remote destination, two selected files, total size, conflict count, target
   writability, and verified host identity.
2. Removing a file updates the manifest, count, size, conflict count, and primary action.
3. Review opens a focus-contained sheet and restores focus on Escape or Cancel.
4. Preflight compares local and remote sizes and explains Keep both / Replace / Skip in outcome language.
5. Start creates batch `tx_01KSSH`; the large file completes and the notes file enters an interrupted resumable state.
6. Retry resumes only the failed file and produces a locked two-of-two completion receipt.
7. Reset restores the exact initial state.
8. At 760px, local/remote panes swap through a segmented control; the manifest, destination, and recovery stay in the
   same document flow.

## Visual brief

- **Character:** operational, precise, calm.
- **Anti-character:** consumer-cloud, neon-terminal, generic card dashboard.
- **Attention order:** route and destination → selected manifest → primary action → file evidence → transfer ledger.
- **Scaffold:** compact Charter activity rail, host header, dual file panes, central route spine, bottom activity ledger.
- **Signature detail:** a restrained copper route line connecting `THIS MAC` to the verified SSH destination and
  continuing into the receipt.
- **Type roles:** serif only for the task headline; sans for controls; mono for paths, IDs, sizes, and receipts.
- **State cues:** label + shape/border + color for conflict, interrupted, completed, and locked states.
- **Motion:** utilitarian progress only; no decorative movement; reduced-motion safe.
- **Narrow transform:** `divide → swap`, `reposition` manifest before panes, `resize` controls to 44px minimum.

## Out of scope

- authentication and host-key mismatch;
- permission-denied target selection;
- download direction;
- multi-host queue administration;
- actual filesystem or network writes.
