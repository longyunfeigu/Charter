# Signing and notarization handoff

Charter `1.0.0-beta.4` intentionally uses the unsigned release path. No certificate is needed to
build, test, or publish a GitHub prerelease. The instructions below are a dormant handoff for a
future signed release; they are not evidence that the current artifacts are signed or notarized.

The 2026-07-22 audit found that the existing Beta 2 Release had been changed to
`prerelease:false` / `Latest`. That metadata-only channel error was corrected without replacing the
tag or assets. At 2026-07-22 23:27 CST, the public metadata was reverified as `prerelease:true`,
`draft:false`; none of this makes the binaries signed or qualifies them as Stable.

## Current unsigned path

- `CHARTER_SIGNING_MODE=unsigned` is the default and disables certificate auto-discovery.
- A stable SemVer such as `1.0.0` is rejected by `scripts/release-policy.mjs` in unsigned mode.
- macOS receives electron-builder's valid ad-hoc bundle signature after Electron fuses are flipped,
  but no Developer ID identity or Apple notarization ticket.
- Windows has no Authenticode signature. Linux has no additional platform signing layer.
- The intended GitHub prerelease attaches SHA-256 checksums and a manifest. These verify bytes, not
  publisher identity.
- `scripts/package.mjs` writes `charterUpdateMode: unsigned` into the packaged metadata. Beta 4 may
  check GitHub Releases and notify the user, but it cannot activate the native downloader or replace
  the application. Published Beta 3 predates this notification UI and remains manual.

## Update activation and feeds

`charterUpdateMode` is a build provenance input, not a user preference. Runtime delivery is
automatic only when all of these are true:

1. Electron reports a packaged application.
2. The platform is macOS or Windows.
3. The packaged `package.json` contains `charterUpdateMode: signed`, injected only by
   `CHARTER_SIGNING_MODE=signed npm run package -- --mac|--win`.

Every other combination fails closed to GitHub Release notification and manual installation. Linux
`.tar.gz` delivery is always manual. Settings can choose Stable/Beta and scheduling, but cannot
promote an unsigned package to native delivery.

Electron Builder must keep the GitHub provider in `electron-builder.yml` even though package commands
use `--publish never`. This emits the metadata uploaded by the tag workflow:

| Channel | macOS metadata | Windows metadata | Runtime channel |
| --- | --- | --- | --- |
| Stable | `latest-mac.yml` | `latest.yml` | `latest` |
| Beta | `beta-mac.yml` | `beta.yml` | `beta` |

The YAML files and the matching ZIP/DMG/NSIS artifacts must belong to the same immutable Release.
Do not hand-edit a feed or reuse one across differently signed bytes. The app disables downgrades,
downloads only on the signed macOS/Windows path, and always waits for **Restart and install**. Before
replacement, Main checks active-work blockers and creates a consistent SQLite backup.

## Future macOS signed build

Prerequisites outside this repository:

1. An Apple Developer Program membership and a **Developer ID Application** certificate exported as
   a password-protected `.p12`.
2. App Store Connect API credentials for notarization (recommended for CI), or an Apple ID
   app-specific password and Team ID.
3. Protected GitHub environment secrets with release approval enabled.

CI secret mapping:

| Secret | Purpose |
| --- | --- |
| `MAC_CSC_LINK` | Base64 `.p12`; map to `CSC_LINK` only in the macOS job |
| `MAC_CSC_KEY_PASSWORD` | `.p12` export password; map to `CSC_KEY_PASSWORD` |
| `APPLE_API_KEY` | Base64 App Store Connect `.p8` |
| `APPLE_API_KEY_ID` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_TEAM_ID` | Developer team ID |

The alternative notarization credentials are `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`. Never store any of these values in the repository, workflow YAML, logs, artifacts,
or support bundles.

Build with `CHARTER_SIGNING_MODE=signed npm run package -- --mac`. Electron-builder uses the explicit
Hardened Runtime and entitlements in `build-resources/`; when notarization credentials are present it
submits through its `@electron/notarize` integration.

Required verification before changing the release channel to Stable:

```bash
codesign --verify --deep --strict --verbose=2 Charter.app
codesign -dvvv Charter.app
spctl --assess --type execute --verbose=4 Charter.app
xcrun stapler validate Charter.app
```

The output must name the intended Developer ID team, pass Gatekeeper assessment, and validate a
stapled notarization ticket. A local ad-hoc signature is not sufficient.

Update qualification additionally requires installing an older signed/notarized build on a clean
machine, publishing a newer signed candidate with matching `latest-mac.yml`, observing background
download, exercising the quit-blocker prompt, confirming the pre-update database backup, choosing
**Restart and install**, and verifying the new version starts with existing Sessions readable.

## Future Windows signed build

Acquire a publicly trusted Authenticode certificate or approved hardware/cloud signing service. Put
its CI material in `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`, map those to electron-builder only in
the Windows signed job, and use `CHARTER_SIGNING_MODE=signed npm run package -- --win`.

Before Stable, verify both the application executable and installer with Windows `Get-AuthenticodeSignature`
or `signtool verify /pa /all /v`, install on a clean SmartScreen-enabled machine, then uninstall and
confirm the installed executable is removed. Self-signed certificates do not satisfy the public
trust gate.

Repeat the signed older-to-newer update qualification on Windows with the matching `latest.yml` and
NSIS/blockmap assets. Verify the explicit restart flow, retained local state and uninstall behavior;
do not infer Windows qualification from the macOS result.

## Secret rotation and failure policy

- Restrict signing secrets to protected tag jobs; do not expose them to pull requests or forks.
- Rotate a credential after suspected disclosure and revoke the old certificate/key with its issuer.
- A signing or notarization failure stops publication. Never fall back from `signed` to `unsigned`
  while retaining a Stable version or title.
- Keep the unsigned prerelease workflow separate. Adding credentials is a reviewed future change,
  not a prerequisite for the zero-cost Beta.
