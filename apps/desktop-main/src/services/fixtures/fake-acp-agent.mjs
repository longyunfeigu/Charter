import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

let ordinal = 0;
const sessions = new Set();

const app = acp
  .agent({ name: 'charter-fake-acp-agent' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { close: {} },
    },
    agentInfo: { name: 'charter-fake-acp-agent', version: '1.0.0' },
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `fake-session-${++ordinal}`;
    sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, ({ params }) => {
    sessions.add(params.sessionId);
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error('unknown fake session');
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: `permission-${ordinal}`, title: 'Fake write' },
      options: [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
      ],
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text:
            permission.outcome.outcome === 'selected'
              ? `accepted:${permission.outcome.optionId}`
              : 'cancelled',
        },
      },
    });
    return { stopReason: 'end_turn' };
  })
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, () => {});

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
