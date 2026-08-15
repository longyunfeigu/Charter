# Agent Packs

Agent Packs let a user add another terminal/ACP coding Agent without adding a provider branch to Charter core. A Pack is declarative JSON: it can name an Agent executable, arguments, session rules, capabilities, discovery surfaces, and bounded lifecycle matchers, but it cannot contain or load extension JavaScript.

## Bundled official Pack

Charter ships the verified, data-only `charter-official-agents` Pack enabled by default. It adds Gemini CLI, OpenCode, GitHub Copilot CLI, Cursor Agent and Aider. The Pack updates with Charter, can be disabled, and cannot be removed, rolled back locally, or replaced by an imported Pack.

The table is deliberately conservative. A check means both the upstream CLI documents/implements the feature and Charter has a corresponding Adapter path. `—` means Charter does not advertise that capability, even when the upstream tool has a related command that is not yet connected to an exact host contract.

| Agent | Local terminal | Native ACP | Image path | ACP load/resume | Exact terminal resume | Native history | Skills | Instructions | SSH | Lifecycle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gemini CLI | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | Observed |
| OpenCode | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | Observed |
| GitHub Copilot CLI | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | Observed |
| Cursor Agent | ✓ | — | — | — | — | — | — | ✓ | ✓ | Observed |
| Aider | ✓ | — | ✓ | — | — | — | — | — | ✓ | Observed |

Important distinctions:

- Gemini, OpenCode and Copilot expose ACP session loading/resumption. The visible terminal route still reports `Exact resume` as unavailable because Charter has not yet implemented a provider identity/history connector for these CLIs.
- Cursor has a CLI resume command, and Aider can restore project chat history, but neither is advertised as exact Charter Resume for the same reason.
- Cursor's internal MCP support is not the same thing as exposing an ACP transport to Charter, so the Pack does not claim `ACP`/`MCP` integration.
- Image support can still depend on the selected model and organization policy. Cursor remains off because no stable official Cursor Agent CLI image-input contract was verified.
- `Done` is an accountable Charter turn-settled edge. Terminal screen rules supply `Working`, `Needs you`, and visible idle evidence; they do not parse or persist private model output.

The process rules for Gemini, OpenCode, Copilot and Cursor are adapted from Herdr's declarative lifecycle manifests at revision `ddffb6e1`. Aider's confirmation, waiting and composer rules are pinned from its current source. Charter adds canonical executable aliases (`cursor-agent → cursor`, `github-copilot/ghcs → copilot`) so local process observation and SSH launches resolve to the same stable Adapter id.

### Validation levels and self-verification

**Settings → Agent → Agent Pack verification** keeps three kinds of evidence separate:

1. **Source verified** — official CLI documentation/source was checked for discovery names, prompt argv, ACP, image, resume, history and Skills/instruction locations; Herdr source was read for screen lifecycle evidence.
2. **Integration tested** — real Electron windows launch PTY executables with the official command names and verify exact argv/deferred Prompt bytes, image paths, canonical process identity, lifecycle rules, Skills installation, SSH probing and SSH launch commands.
3. **Locally verified** — the user explicitly starts a visible terminal using an installed, logged-in CLI. Charter sends one read-only random challenge. The expected answer never appears in the Prompt, so terminal echo cannot be mistaken for a model reply. Launch, authentication, Prompt response, Working and Done must all be observed before this level passes.

The free **Rescan** action only reads executable availability, version and declared local surfaces. It never invokes a model. **Run live check** is explicit, may consume one provider request, leaves the terminal visible for login/trust input, and can be stopped without killing the Agent terminal. When a real login, trust or approval gate appears, the same run records **Needs you**. Agents that declare images expose a separate clipboard-image check after the core check passes. Local and saved SSH targets use the same challenge.

**Export report** writes a human-readable Markdown report plus a JSON companion. Reports and the private local ledger never contain the challenge Prompt, terminal output, workspace/executable paths, SSH host details, tokens, usernames or account identities.

The developer machine used for this implementation did not have the five provider CLIs installed or authenticated. Therefore the current gate does **not** claim a live model/provider certification. That final level must run against installed, logged-in upstream CLIs and should be repeated for each supported version.

Automated acceptance:

```sh
npm run check
npm test
npm run build
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/official-agent-pack.spec.ts
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/agent-verification.spec.ts
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/ssh-remotes.spec.ts --grep "official Pack probes"
```

Manual acceptance:

1. Open **Settings → Agent → Agent Adapters**. Confirm **Charter Official Agents** is `official`, `verified`, enabled, non-removable, and lists all five IDs.
2. Install one upstream CLI, select **Rescan**, and confirm it changes to **Installed** without invoking or logging into the provider.
3. Select **Run live check**. Complete provider login/trust input in the visible terminal if requested. Confirm the row reaches **Locally verified** only after a real reply and Working/Done evidence.
4. For an image-capable Agent, copy a PNG and select **Test clipboard image**. Confirm the separate image check passes. Cursor must not show that action.
5. Select a saved host in the verification target and repeat the live check through SSH.
6. Export the report and inspect both files. Confirm they contain results and versions but none of the private fields listed above.
7. Confirm Resume/History labels match the matrix. Do not accept an approximate provider chat restore as Charter `Exact resume` or `Native history`.

## Install and manage

1. Open **Settings → Agent → Agent Adapters**.
2. Select **Install Pack…** and choose a JSON Pack from local disk.
3. Charter validates the entire Pack before storing it. A successful Pack is enabled immediately; Agent discovery, terminal process recognition, lifecycle rules, ACP registration, Skills roots, and new-session launch choices refresh without restarting the app.
4. Use **Disable**, **Enable**, **Roll back**, or **Remove** on the Pack row. Disabling/removing affects new selection and discovery. A runtime adapter already retained by an in-flight ACP Mission stays available until that Mission can be safely stopped or the app quits.

Explicitly selected unsigned files are labeled `local`. A Pack that claims an Ed25519 signature is accepted only when its `keyId` exists in the host build's trusted publisher keys and the signature verifies; an unknown or bad signature is rejected rather than silently downgraded to `local`.

Pack versions use SemVer. Installed version contents are immutable:

- publishing different contents under the same version is rejected;
- importing an older version is rejected;
- updating preserves the previous version;
- **Roll back** atomically swaps the current and previous stored versions, so it is also possible to roll forward again.

Packs cannot replace built-in Adapters or an Adapter owned by another Pack. Local developer overrides remain a separate, explicitly enabled development facility.

## Minimal terminal Pack

Save the following as `my-agent.charter-agent-pack.json`, then replace `my-agent` and its launch contract with the real CLI values. The command is resolved directly from `PATH`; no shell command string is evaluated.

```json
{
  "schemaVersion": 1,
  "id": "my-agent-pack",
  "version": "1.0.0",
  "displayName": "My Agent Pack",
  "publisher": "Your Name",
  "engine": { "min": 1, "max": 1 },
  "adapters": [
    {
      "schemaVersion": 1,
      "adapterVersion": "1.0.0",
      "engine": { "min": 1, "max": 1 },
      "id": "my-agent",
      "displayName": "My Agent",
      "shortName": "My Agent",
      "description": "A terminal coding Agent installed from an Agent Pack.",
      "mark": "generic",
      "accent": "#456789",
      "discovery": {
        "commands": ["my-agent"],
        "knownPaths": [],
        "versionArgs": ["--version"]
      },
      "terminal": {
        "promptDelivery": "deferred",
        "startup": {
          "gateMarkers": [],
          "readyMarkers": [],
          "readyRequired": false,
          "requireBracketedPaste": true,
          "deferInitialProbe": false,
          "updateGate": null
        },
        "exitSequence": ["interrupt", "eof"]
      },
      "acp": null,
      "sessions": null,
      "surfaces": {
        "skillRoots": [],
        "instructionRoots": [],
        "remote": true
      },
      "capabilities": {
        "terminal": true,
        "acp": false,
        "loadSession": false,
        "sessionList": false,
        "sessionResume": false,
        "images": true,
        "embeddedContext": false,
        "mcp": false,
        "exactResume": false,
        "history": false,
        "skills": false,
        "instructions": false,
        "remote": true,
        "lifecycle": "none"
      },
      "lifecycle": null
    }
  ]
}
```

`images: true` means this Agent accepts image file paths in its composer. For a live local or SSH Agent Session, copy an image and select **Paste image** in the Session bar:

- Charter normalizes the clipboard image to PNG and enforces a 10 MB limit.
- A local Session receives a bracketed-pasted path to a `0700`/`0600` private OS temporary location.
- An SSH Session uploads through the existing authenticated SFTP transport to `~/.charter/tmp/image-paste/<session-id>/`, applies private permissions, verifies the remote byte count, and then bracket-pastes the remote path.
- Charter never presses Enter. The user can add text or cancel before submitting.
- Staged files are removed when the terminal exits or Charter quits; 24-hour local/remote TTL cleanup is the crash fallback.

Image paste is an explicit action and never takes over ordinary text paste.

## ACP

A Pack may declare native ACP with `"acp": { "kind": "native", "args": ["acp"] }` and the matching capability flags. User Packs cannot select a bundled JavaScript ACP package. When ACP compatibility is enabled, newly installed native ACP Adapters are registered immediately; normal visible-terminal fallback remains available.
