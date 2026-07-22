# Charter 1.0 Beta 2 — Unsigned Preview

Charter's complete Session-first desktop workflow is available as a public, zero-cost preview for
macOS Apple Silicon, Windows x64 and Linux x64.

## New since Beta 1

- Visible session orchestration: external Claude Code/Codex sessions join a coordinated fleet with
  a command center view, driven through a per-session MCP control bridge — no dotfile edits.
- Agent worker restart resilience: changing provider credentials or losing the worker mid-start no
  longer leaves the model catalog empty until app restart.
- Beta 1 was gated out by its release pipeline and never published; Beta 2 is the first downloadable
  preview.

## Highlights

- One durable Session for conversation, plans, managed Agent work, external Claude Code/Codex PTYs,
  live file activity, Preview, Terminal, verification, review, rollback, Replay and Memory.
- Sandboxed Electron renderer, versioned IPC, host-side Tool Gateway policy, content/path containment,
  secret redaction and packaged Electron fuse hardening.
- Byte-exact file rollback, crash/interruption recovery, database migration backup/restore and
  deterministic 50-task soak coverage.
- Release artifacts accompanied by an SPDX SBOM, third-party license inventory, machine-readable
  manifest and SHA-256 checksums.

## Important installation notice

These artifacts are **unsigned and not notarized**. macOS Gatekeeper and Windows SmartScreen/Smart App
Control may warn or block them. Do not disable operating-system security globally. If your local policy
does not allow unsigned applications, build from source or wait for a signed release.

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

Updates are manual in this preview. Quit Charter, back up its application-data directory, verify the
new artifact, and replace the app. Before applying a database schema migration, Charter automatically
creates a timestamped backup and restores it if the migration fails.

Read the
[known limitations](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.2/docs/KNOWN_LIMITATIONS.md),
[recovery guide](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.2/docs/RECOVERY.md),
[privacy notice](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.2/PRIVACY.md), and
[security policy](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.2/SECURITY.md) before using
the preview on important repositories.
