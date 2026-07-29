# ADR-0048: Signed desktop updates with fail-closed preview delivery

- Status: Accepted
- Date: 2026-07-29
- Related: M12-02/03/05/07, ADR-0043, §12.2 update supply chain, E2E-023/024

## Context

Charter needs to tell users when a newer release exists without weakening ADR-0043's rule that an
unsigned preview must never download and execute an application replacement. A desktop IDE also
cannot restart as soon as a download finishes: active terminals, dirty documents and running agent
work must remain under the user's control.

GitHub Releases is already the publication boundary. Electron Builder can emit signed macOS and
Windows update metadata for that boundary, while Linux continues to ship as a `.tar.gz` preview
without a supported in-place installer.

## Decision

1. Use `electron-updater@6.8.9` for packaged, signed macOS and Windows builds. Check 15 seconds after
   startup and every six hours when automatic checks are enabled; expose **Check now** in Settings
   and make the Updates pane reachable from the application menu.
   Available/manual and downloaded/signed states also raise a persistent in-app action card: its
   body opens Updates, while its primary action opens the Release or explicitly restarts to install.
   It stays until the user handles, postpones or dismisses that version.
2. Download a discovered signed update in the background, but never install it or restart Charter
   automatically. Installation requires the user's **Restart and install** action. Existing quit
   blockers are shown first, and proceeding through them requires a second explicit confirmation.
3. Before `quitAndInstall`, checkpoint WAL state and create a consistent `node:sqlite` backup in the
   existing backup directory. A backup failure stops installation and leaves the running app intact.
4. Gate native delivery on two facts that renderer settings cannot forge: `app.isPackaged` and the
   packaged `package.json` value `charterUpdateMode: signed`. `scripts/package.mjs` injects that value
   only when `CHARTER_SIGNING_MODE=signed`; all ordinary/preview builds receive `unsigned` and fail
   closed to manual delivery.
5. For unsigned macOS/Windows previews and Linux, query the GitHub Releases API, compare strict
   SemVer, notify the user and open the selected Release page. These paths never call the native
   downloader or expose installer paths to the renderer. Linux remains manual even when signed.
6. Keep two channels. Stable consumes Electron Builder's `latest` feed and ignores prereleases;
   Beta consumes `beta` and may receive both prereleases and later Stable versions. Downgrades are
   disabled. Release jobs upload the generated YAML alongside packages and checksums.
7. Send only schema-validated update state and actions across IPC. The renderer may request a check,
   open the approved HTTPS release URL, or request installation; Main owns feed selection, package
   trust, database backup and application replacement.

## Alternatives

- Automatic restart after download: rejected because it can interrupt terminal and agent work.
- Native auto-update for unsigned previews: rejected by ADR-0043 and OS trust requirements.
- A custom downloader/patcher: rejected because it would duplicate signature, feed and replacement
  machinery while creating a larger privileged attack surface.
- In-place Linux `.tar.gz` replacement: deferred until Charter has a supported package/update format
  and platform qualification for it.

## Security and data impact

Update YAML and platform signatures are release supply-chain inputs, not renderer-controlled data.
Unsigned package metadata cannot activate the native updater, changing channels never enables a
downgrade, and failed checks do not modify the current installation. The pre-install SQLite backup
contains the same local data as the application database and remains inside the existing local
backup boundary.

## Migration and rollback

No schema migration is required. Rolling back the feature means publishing a newer signed release
that disables native delivery or directing users to reinstall a known-good version manually; the
updater itself never performs a downgrade. Pre-update backups remain available to the existing
recovery path. Preview users continue to use the Release page.

## Verification

- Update service unit tests cover strict SemVer, channel filtering, signed download/install,
  backup-before-install and failure behavior.
- IPC contract tests validate every update state, request, result and event without executable data.
- Electron E2E renders persistent manual-available and signed-downloaded action cards, including
  settings navigation, later/restart actions and a narrow desktop viewport.
- The macOS package emits `beta-mac.yml`; packaged `app-update.yml` selects `channel: beta`; the ASAR
  contains `electron-updater@6.8.9` and `charterUpdateMode: unsigned` for the preview build.
- The real DMG install smoke passes clean installation, launch/security checks, daemon survival
  across a full restart and cleanup.
