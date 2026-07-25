# SSH / SFTP same-case comparison

## What is being compared

The historical chat transcript is not present in the ADE search index. Repository evidence identifies the previous
Skill output and its recorded brief:

- Previous:
  [`../mock-html-skill-showcase/sftp-transfer.html`](../mock-html-skill-showcase/sftp-transfer.html)
- Latest:
  [`index.html`](index.html)
- Interactive comparison:
  [`compare.html`](compare.html)
- Frozen contract:
  [`contract.md`](contract.md)

Both versions use:

- `prod-api-01` / `root@10.0.3.46`;
- `~/Projects/charter` → `/home/deploy/releases`;
- `charter-1.0.0.dmg` · 98.2 MB and `release-notes.md` · 4.1 KB;
- one existing remote DMG conflict;
- an interrupted transfer with resumable recovery;
- 1440 × 900 and 760 × 820 viewports.

## Product model comparison

| Dimension | Previous Skill output | Latest Skill output |
| --- | --- | --- |
| Familiarity | Classic dual pane + command arrows | Preserves dual pane |
| Primary attention | File lists and existing global queue | Route, destination, current manifest |
| Conflict | Modal presents three policies | Preflight previews the resulting remote directory |
| Progress | New batch is added beside unrelated existing jobs | One ledger follows the same batch |
| Recovery | Retry button changes to “正在重试…” but the failed item never reaches completion | Only the interrupted file resumes; completed file does not restart |
| Completion | Progress reaches 100%, no batch receipt | Locked `TX_01KSSH` receipt records target, policy, count, and hash |
| Time boundary | Selection and queue history share one undifferentiated surface | Current Draft and Last locked batch are explicit |
| Narrow layout | Three panes reflow into a long document | Manifest comes first; Local/Remote swap through tabs |

## Strict current-rubric result

The previous showcase recorded 94/100 under its earlier self-review. Under the current Skill rubric, the incomplete
failed-item recovery prevents recommendation; the number should not be compared directly with the latest result.

| Category | Previous, strict recheck | Latest |
| --- | ---: | ---: |
| Product fitness | 21/25 | 24/25 |
| Interaction quality | 19/25 | 24/25 |
| Visual craft | 18/20 | 19/20 |
| Accessibility/adaptation | 13/15 | 13/15 |
| Evidence/integrity | 8/10 | 9/10 |
| Prototype proof | 3/5 | 5/5 |
| **Total** | **82 · blocked** | **94 · recommended** |

### Previous blocker

`#retry-transfer` changes to disabled “正在重试…”, while the queue continues to show
“连接中断 · 已保留断点”. It provides no successful terminal state or completion receipt. Failure recovery is part of the
frozen user job, so the current rubric treats this as a blocker.

### Latest evidence

- Review → Escape closes the native dialog and restores focus to Review upload.
- Keep both / Replace atomically / Skip updates a result preview in outcome language.
- Start completes and verifies the DMG, then interrupts `release-notes.md` at 68%.
- Retry resumes only `release-notes.md` from 2.8 KB.
- Completion locks a 2-of-2 `TX_01KSSH` receipt and hash.
- Changing the next draft selection does not mutate the old receipt.
- The 760px Local/Remote tabs preserve the manifest, target, conflict, retry, and receipt.
- No relevant console/page error or document-level horizontal overflow.

## Recursive visual corrections

| Pass | Rendered defect | Change | Verification |
| --- | --- | --- | --- |
| 1 | Hidden pane switch caused the ledger to occupy the flexible file-workspace row, creating a large empty block | Explicitly assigned grid rows to switch, workspace, and ledger | Re-rendered 1440 initial and complete states |
| 1 | Remote three-column rows inherited the local four-column grid, crushing filenames | Added remote-pane grid semantics | Re-rendered remote list |
| 1 | Completed receipt and editable next selection could appear temporally contradictory | Renamed current header to Next Transfer Draft and ledger to Last completed batch | Receipt snapshot assertion after selection change |
| 2 | Transient completion toast covered the narrow manifest in immediate screenshots | QA waits for the transient message before visual capture; essential status remains in the ledger | 760 full-page screenshot |

## Verification

- Electron Playwright through `tests/e2e/helpers/launch.ts`.
- Exact viewports: 1440 × 900 and 760 × 820.
- Latest full path and previous limitation checks pass.
- Latest static audit clean, including hidden-state integrity.
- JavaScript syntax and Prettier checks pass.
- Temporary screenshots are under `/tmp`.
