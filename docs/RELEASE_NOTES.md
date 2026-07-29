# Charter 1.0 Beta 4 — Unsigned Preview

Charter's complete Session-first desktop workflow is available as a public, zero-cost preview for
macOS Apple Silicon, Windows x64 and Linux x64.

This SemVer Beta is an **unsigned prerelease** published with GitHub's Prerelease flag; it is not
Stable or Latest.

## New since Beta 3

- Update checks are now built into Charter. This unsigned Beta checks GitHub Releases and shows a
  persistent **View & download** card; signed future builds can download in the background and wait
  for an explicit **Restart & install** action with quit-blocker and database-backup protection.
- SSH workspaces add remote project discovery, host-key and credential handling, SFTP browsing and
  transfers, remote terminals, forwards, reconnect recovery and strict secret/IPC boundaries.
- Terminal file links can open local and remote text, image, PDF and HTML artifacts in a dedicated
  in-app preview without losing the originating Session or terminal context.
- Managed and external agent Sessions retain stronger identity, output evidence and recovery state
  across application restarts; fleet control and Session attention behavior are more reliable.
- Preview element feedback carries semantic DOM context, while artifact, PDF and attachment surfaces
  provide clearer loading, error, review and narrow-window behavior.

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

Beta 4 checks for newer GitHub prereleases after startup and then periodically. Because these
artifacts are unsigned, Charter only shows the verified Release page; download and replacement remain
manual. Beta 3 predates this feature, so existing Beta 3 users must install Beta 4 manually once.

Quit Charter before replacing it, retain a backup of the application-data directory and verify the
new artifact. Before applying a database schema migration, Charter automatically creates a
timestamped backup and restores it if the migration fails.

Read the
[known limitations](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.4/docs/KNOWN_LIMITATIONS.md),
[recovery guide](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.4/docs/RECOVERY.md),
[privacy notice](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.4/PRIVACY.md), and
[security policy](https://github.com/longyunfeigu/Charter/blob/v1.0.0-beta.4/SECURITY.md) before using
the preview on important repositories.
