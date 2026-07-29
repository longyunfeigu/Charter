# M12 Release Checklist

## Unsigned public Beta (`1.0.0-beta.4`)

- [x] SemVer prerelease version and matching `v1.0.0-beta.4` tag policy.
- [x] Unsigned releases are restricted to prerelease channels; unsigned Stable fails closed.
- [x] macOS, Windows and Linux native package/install workflows are defined.
- [x] E2E-023 migration and backup restore coverage.
- [x] E2E-024 real packaged-application coverage.
- [x] Static, unit, performance, Electron E2E, security, soak and dependency gates are wired into `release:verify`.
- [x] DMG clean install/launch/cleanup smoke passed locally.
- [x] SPDX SBOM, license inventory, third-party notices, artifact manifest and SHA-256 checksums are generated.
- [x] Security, privacy, recovery, signing, known-limitations and release-note documents are present.
- [x] GitHub tag workflow creates a Prerelease only after all native package jobs pass.
- [x] The tag workflow blocks publication until its release gates and macOS, Windows and Linux package matrix pass.
- [x] The publish job creates a GitHub Prerelease with `--latest=false` and attaches native packages, manifest, checksums and SBOM.

Beta 3 remains available as the previous preview, but it predates the update notification service and
must be upgraded to Beta 4 manually.

## Update delivery in the current source

- [x] Strict SemVer Stable/Beta selection and downgrade refusal.
- [x] Packaged unsigned macOS/Windows and Linux check GitHub Releases but only offer the Release page.
- [x] Signed macOS/Windows use `electron-updater` for background check/download and require an explicit restart/install action.
- [x] Native delivery fails closed unless packaged metadata says `charterUpdateMode: signed`.
- [x] Active-work quit blockers are shown before install and forcing past them requires confirmation.
- [x] A consistent SQLite backup is created before `quitAndInstall`; backup failure stops replacement.
- [x] Release collection/workflow includes updater YAML, and Beta packaging emits `beta-mac.yml` with package feed `channel: beta`.
- [x] Unit, typed IPC and real Electron Updates-page E2E pass; real DMG install/restart smoke passes 2/2.

These checks ship in Beta 4. They do not retroactively add update support to the already-published
Beta 3 artifacts, and they do not qualify signed production delivery.

## Stable handoff (intentionally not claimed)

- [ ] Obtain Apple Developer Program membership and Developer ID Application credentials.
- [ ] Configure Apple notarization credentials and validate Gatekeeper acceptance.
- [ ] Obtain a trusted Windows code-signing certificate and validate SmartScreen/install behavior.
- [ ] Qualify older-to-newer signed updates on clean macOS and Windows machines, including feed/signature validation, quit blockers, pre-install backup, retained Sessions and uninstall behavior.
- [ ] Run the fixed 20-task real-provider evaluation with owner-approved credentials.
- [ ] Obtain product-owner sign-off on the Stable test report.

The user selected the zero-cost Beta path. These Stable items do not block the GitHub Prerelease, but they do block any build labeled Stable.
