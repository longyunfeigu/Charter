# ADR-0049: Native PTY Mission data plane

- Status: Accepted
- Date: 2026-07-31
- Supersedes: the ACP-default runtime decision in Mission Fabric V3
- Related: ADR-0017, ADR-0030, ADR-0044, `docs/design/mission-fabric-v3.md`

## Context

Mission Fabric originally made ACP the default Claude/Codex worker runtime. That put provider token
and tool updates on the same path as durable coordination state: ACP notification → JSON
serialization → SQLite runtime event → Mission snapshot → Electron IPC → React. Real Mission data
contained hundreds of events and multi-megabyte tool payloads. Human-visible terminal interaction
therefore paid control-plane persistence and rendering costs that a normal shell PTY does not pay.

Orca demonstrates the stronger boundary: every interactive agent remains a native PTY/TUI, while
task dispatch, messages, heartbeat and completion travel as small structured RPC records. Its PTY
transport separately applies batching, flow control, foreground priority and renderer ACKs.

## Decision

1. Claude and Codex Mission Assignments use the real user-installed executable in a native PTY by
   default. No same-name MCP wrapper shadows `claude` or `codex` on PATH.
2. Raw PTY output is a high-frequency data plane. It may exist in bounded in-memory/daemon replay,
   but never enters Mission events, SQLite snapshots or React Mission state.
3. `charter-orchestration` is the model instruction surface. `charter orchestration ...` over the
   authenticated local socket is the default external-agent control transport. MCP is an explicit
   projection of the same command contract, not a dependency.
4. Mission messages are durable small records. A runtime receives only a coalesced inbox doorbell;
   content is fetched with `sync`. A doorbell waits for a real turn boundary and is marked delivered
   only after its bytes are handed to the runtime.
5. Attempt lifecycle is explicit. `progress`, `heartbeat` and `complete` carry the active Attempt
   identity; terminal quietness, process presence and model prose cannot complete an Assignment.
6. Terminal transport reserves renderer credit for the active pane, round-robins background panes,
   requires xterm ACKs and bounds daemon/socket queues.
7. Daemon session listing is metadata-only. Full VT replay is fetched lazily per restored terminal;
   large snapshot responses are never retained in the daemon request cache.
8. ACP remains available only when explicitly enabled (`PI_IDE_ACP=1`) and for recovery of legacy
   ACP bindings. ACP event payloads and snapshot exposure stay bounded.

## Consequences

- A Mission Claude/Codex session has the same input echo and TUI rendering path as a direct terminal
  session; adding more agents does not route their screen output through the Mission store.
- Agent coordination remains durable across app/runtime restarts without scraping terminal output.
- Users who install the Charter Skills get the same orchestration behavior in manually launched
  Claude/Codex sessions. The initial Mission prompt still names the CLI protocol so Mission-created
  workers are usable without an MCP handshake.
- Native workers are visible sessions. Mission UI retains the richer Assignment/Attempt/artifact and
  recovery model instead of adopting Orca's smaller runtime-global task database.
- Opt-in MCP compatibility launchers are named `charter-claude-mcp` and `charter-codex-mcp`; they do
  not affect normal executable resolution.

## Verification

- Unit: turn-safe/coalesced/cancellable doorbells, delivery state timing, active-terminal renderer
  reserve, daemon compact listing and lazy per-session resync.
- Integration: native executable resolution, Mission snapshot payload bounds, explicit completion
  authority and restart recovery.
- Electron: direct Claude/Codex input remains responsive with several background agents; completed
  Assignments stop animating even when their resident CLI stays open.
- Live provider: recursive five-Agent delegation, peer question/reply, handoff chain and fan-in over
  Skill + CLI/RPC, with ACP disabled.
