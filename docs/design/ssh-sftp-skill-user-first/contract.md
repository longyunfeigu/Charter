# SSH / SFTP ordinary-user forward-test contract

## Frozen brief

保持双栏文件管理习惯，让用户把本机文件直接传到远程目录；目标、冲突、进度和失败恢复必须清楚。

## Dominant task

Given two local release files and an open remote folder, the user can drag the selected files to the remote pane or
use the visible upload action, resolve one filename conflict, and recognize when both files reach the destination.

## Baseline-strength ledger

| Advantage | User value | Evidence | Decision | Acceptance check |
| --- | --- | --- | --- | --- |
| Local and remote directories remain side by side | Reduces memory and direction errors | Previous rendered mock and repository ADR | Preserve | Both paths and file lists are simultaneously visible at 1440 × 900 |
| Direct drag and visible directional buttons | Reduces learning and action cost | Domain convention and repository ADR | Preserve and implement | Drag and button start the same upload flow |
| Large file browsing area | Reduces scanning and attention cost | Previous rendered mock | Preserve | File panes own most of the initial workspace |
| Persistent transfer center | Keeps progress and recovery visible | Previous mock and repository ADR | Preserve, reduce initial weight | It stays at the right but reveals detail only after transfer begins |
| Persistent unrelated queue detail | Competes with current browsing | Previous rendered mock | Discard | Initial transfer center is quiet and does not dominate |
| Conflict confirmation | Prevents unintended replacement | Previous mock | Preserve progressively | It appears only after the upload gesture |

## Ordinary-user rehearsal

`see selected local files and open remote folder → infer left-to-right upload → drag or click Upload → see exact
conflict result → choose Keep both → see progress in Transfer Center → retry only the interrupted file → see 2/2
complete`

- First visible cue: selected files beside the open destination.
- First action: drag to the remote pane or click the central upload button.
- Ordinary successful path: upload gesture → conflict decision → start.
- Facts held in memory: none; source, destination, selection, and resulting filename remain visible.
- Workspace priority: the two file panes, not explanatory or historical chrome.

## Behavior directions

### Conventional — chosen

Keep the dual-pane spatial model, direct drag, and directional buttons. Add conflict and recovery only when triggered.

### Task batch

Create a persistent manifest between the panes. Rejected because it narrows both file lists and adds a staging model
to the common path.

### Queue first

Drop files into a transfer cart before selecting a target. Rejected because it breaks the direct source-to-destination
relationship.

## Behavior contract

1. Both file panes, their paths, the selected count, and the destination are visible on desktop.
2. Selected local rows are draggable; dropping on the remote pane opens the same conflict flow as the upload button.
3. The remote pane visibly changes during drag-over and provides a conventional upload fallback.
4. The conflict sheet defaults to Keep both, previews the resulting filename, closes on Escape, and restores focus.
5. Starting creates one current batch in Transfer Center. One file completes and one becomes resumably interrupted.
6. Retry resumes only the interrupted file and ends at a 2/2 completion receipt.
7. At 760px, Local and Remote switch through tabs; upload stays visible and Transfer Center becomes a compact drawer.
8. Reset restores the initial selection and quiet Transfer Center.

## Visual brief

- Character: calm desktop utility, spatially direct, operational.
- Anti-character: marketing page, architecture diagram, generic card dashboard.
- Attention order: selected local files → remote destination → upload action → transfer status.
- Scaffold: compact host bar; large dual pane; narrow transfer gate; right transfer center.
- Signature detail: a copper direction line appears only while dragging or transferring.
- Motion: utilitarian progress and drop-target feedback; reduced-motion safe.

## Scope

Mock the file workspace, conflict sheet, and transfer center because they close one upload and recovery loop. Exclude
host management, authentication, terminal, port forwarding, and historical batch administration.
