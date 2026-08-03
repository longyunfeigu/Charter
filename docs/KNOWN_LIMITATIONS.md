# Known limitations — Charter 1.0.0-beta.6

This is an unsigned public preview, not the signed Stable release defined by the original V1.0
release gates.

## Installation and updates

- macOS and Windows artifacts are unsigned and not notarized. Gatekeeper, SmartScreen, Smart App
  Control, enterprise policy, or antivirus software may warn or refuse to launch them.
- Charter does not ask users to disable operating-system security globally. If the local policy does
  not permit the artifact, build from source or wait for a signed release.
- This unsigned Beta checks GitHub Releases and displays a persistent update notice, but download and
  application replacement remain manual. Native background download/install requires a signed macOS
  or Windows build; Linux delivery is always manual.
- There is no automatic downgrade. A database backup is created before a schema migration; restoring
  an older app may require restoring its matching database backup.
- macOS preview artifacts target Apple Silicon (`arm64`). Windows targets `x64`; Linux Preview targets
  `x64` and is distributed as a tarball.
- Exact byte-for-byte reproduction of compressed installers across operating-system images is not yet
  claimed. Dependencies are pinned and every published byte has a recorded SHA-256 digest.

## Provider and Agent limits

- Managed-provider authentication supports API keys. OAuth provider login is not implemented.
- `validateCredential` confirms that a credential exists locally; the first real provider request is
  the authoritative live validation and error classification path.
- Real-provider E2E requires the owner's API key and is not part of the public, credential-free CI
  run. Deterministic mock-runtime flows exercise the same Tool Gateway and review machinery.
- `get_symbols` and `get_diagnostics` are not registered as managed Agent tools. The editor's language
  intelligence remains available to the user.
- Python intelligence depends on a compatible language server installed on the machine; otherwise the
  UI presents installation guidance.
- External Claude Code, Codex, Kimi Code and custom Manifest sessions use the external CLI's
  permission and network model rather than Charter's managed Tool Gateway policy.
- Credential-free CI exercises Mission orchestration with deterministic runtimes. Real Claude Code
  and Codex Mission suites are opt-in and require the owner's installed CLI/authentication; this Beta
  does not claim a fixed large-scale real-model qualification.

## Replay and Skills limits

- Terminal Replay records real PTY output only. Managed non-PTY Agent Sessions do not receive a
  synthetic recording.
- Terminal recordings can contain commands and terminal output. They remain local under Charter's
  application-data directory, are included in the Settings storage summary, and are removed by
  **Delete history & cache**. The recorder keeps a bounded rolling set (up to 60 recordings or
  800 MB).
- Observable Skill usage is currently attributed to Charter, Claude Code and Codex. Kimi Code and
  custom Agent usage is not yet counted, even when their installed Skills appear in the catalog.

## Product and release limits

- No telemetry or crash-report transport ships in this build.
- Beta/Stable feed selection and update checks are implemented. Native background download/install
  remains unavailable in this unsigned build and requires qualified signed distribution.
- The fixed real-model 20-task evaluation and paid signing/notarization gates remain open; therefore
  this build must not be described as Stable.
