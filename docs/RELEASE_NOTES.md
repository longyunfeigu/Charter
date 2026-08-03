# Charter 1.0 Beta 5 — Unsigned Preview

Charter's Session-first desktop workflow is available as a public, zero-cost preview for macOS
Apple Silicon, Windows x64 and Linux x64.

This SemVer Beta is an **unsigned prerelease** published with GitHub's Prerelease flag; it is not
Stable or Latest.

## New since the current public Beta 3

The `v1.0.0-beta.4` tag did not produce a public GitHub Release, so Beta 3 remains the public comparison baseline.

- **Mission orchestration:** create durable multi-Agent Missions, dispatch managed or native CLI
  workers, inspect their graph and activity, handle decisions, and continue work across restarts.
- **Agent and Worktree control:** discover Claude Code, Codex, Kimi Code and extensible local Agent
  manifests; choose the current checkout or an isolated Worktree when starting a Session instead of
  forcing every Agent into a new branch.
- **Session-first project management:** projects, active Sessions and History are easier to browse;
  running Sessions can be stopped together, child workers stay visibly nested, and selection and
  attention states have clearer, lighter visual treatment.
- **Terminal Replay and recovery:** native terminal output is recorded efficiently and can be
  replayed, inspected and recovered while detached PTYs retain stronger identity and lifecycle
  guarantees across application restarts.
- **Observable Skills:** the Skills catalog scopes installation and usage to the selected Agent,
  detects Codex skill calls such as web access, and exposes immediate in-app diagnostics instead of
  delayed browser tooltips.
- **Project evidence:** aggregate Session diffs, archive browsing, preview feedback and project
  inspection provide a clearer path from Agent activity to reviewable evidence.
- **Update and remote workflows:** built-in prerelease checks, SSH workspaces, remote file preview and
  hardened external Session recovery are included in this build.

## Highlights

- One durable Session for conversation, plans, managed Agent work, external CLI PTYs, live file
  activity, Preview, Terminal, verification, review, rollback, Replay and Memory.
- Sandboxed Electron renderer, versioned IPC, host-side Tool Gateway policy, content/path containment,
  secret redaction and packaged Electron fuse hardening.
- Byte-exact file rollback, crash/interruption recovery, database migration backup/restore and
  deterministic soak coverage.
- Release artifacts accompanied by an SPDX SBOM, third-party license inventory, machine-readable
  manifest and SHA-256 checksums.

## Important installation notice

These artifacts are **unsigned and not notarized**. macOS Gatekeeper and Windows SmartScreen/Smart App
Control may warn or block them. Do not disable operating-system security globally. If your local
policy does not allow unsigned applications, build from source or wait for a signed release.

Before running a download, verify it against `SHA256SUMS.txt` attached to this Release.

The Linux tarball uses Chromium's setuid sandbox. After extracting it, configure the helper before
launching Charter (replace `<extracted-directory>` with the directory created by the archive):

```sh
sudo chown root:root <extracted-directory>/chrome-sandbox
sudo chmod 4755 <extracted-directory>/chrome-sandbox
<extracted-directory>/charter
```

Do not launch the Linux build with `--no-sandbox`.

## Updates and data

Beta 5 checks for newer GitHub prereleases after startup and then periodically. Because these
artifacts are unsigned, Charter only shows the verified Release page; download and replacement remain
manual. Beta 3 predates this feature, so existing Beta 3 users must install Beta 5 manually once.

Quit Charter before replacing it, retain a backup of the application-data directory and verify the
new artifact. Before applying a database schema migration, Charter automatically creates a
timestamped backup and restores it if the migration fails.

Read the
[known limitations](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.5/docs/KNOWN_LIMITATIONS.md),
[recovery guide](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.5/docs/RECOVERY.md),
[privacy notice](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.5/PRIVACY.md), and
[security policy](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.5/SECURITY.md) before using
the preview on important repositories.
