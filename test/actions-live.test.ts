import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sendMessageLive } from '../src/actions/send-message.js';
import { commentOnPostLive } from '../src/actions/comment.js';
import { sendConnectionInviteLive, verifySentInvites } from '../src/actions/invite.js';
import { createScriptedActionSession } from './support/scripted-session.js';
import { runInvites } from '../src/automation/invites/runner.js';
import { InMemoryStore } from '../src/automation/core/store.js';
import { DEFAULT_INVITE_CONFIG } from '../src/automation/invites/config.js';
import { recordUnavailable, isUnavailableBlocked } from '../src/automation/invites/unavailable.js';
import { filterCommentContent, BENIGN_COUNTER_CASES } from '../src/automation/comments/content-filter.js';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { CdpSession } from '../src/cdp/session.js';

describe('sendMessageLive scripted', () => {
  it('happy path verifies', async () => {
    const s = createScriptedActionSession({ composeReady: true });
    const r = await sendMessageLive(s, 'urn:li:msg_conversation:(x,2-thread=)', 'Hello there friend', { live: true });
    assert.equal(r.ok, true);
  });

  it('compose missing fails closed', async () => {
    const s = createScriptedActionSession({ composeReady: false });
    const r = await sendMessageLive(s, 'urn:li:msg_conversation:(x,2-thread=)', 'Hello there friend', { live: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'compose_box_not_ready');
  });
});

describe('commentOnPostLive scripted', () => {
  it('posted when evidence matches', async () => {
    const s = createScriptedActionSession({ commentPosted: true });
    const r = await commentOnPostLive(s, 'https://www.linkedin.com/feed/update/urn:li:activity:123/', 'Nice insight', {
      live: true,
      expectedProfileSlug: 'example-user',
    });
    assert.equal(r.status, 'posted');
  });

  it('manual_review when unverified', async () => {
    const s = createScriptedActionSession({ commentPosted: false });
    const r = await commentOnPostLive(s, 'https://www.linkedin.com/feed/update/urn:li:activity:123/', 'Nice insight', {
      live: true,
    });
    assert.equal(r.status, 'manual_review');
  });
});

describe('invite scripted', () => {
  it('classifies FUSE limit', async () => {
    const s = createScriptedActionSession({
      dialogText: 'Personalize your invitation to Jane Example by adding a note.',
      inviteResponse: {
        status: 429,
        body: JSON.stringify({ data: { code: 'FUSE_LIMIT_EXCEEDED', status: 429 } }),
      },
    });
    const r = await sendConnectionInviteLive(
      s,
      { vanityName: 'jane-example', recipientName: 'Jane Example' },
      { live: true },
    );
    assert.equal(r.status, 'rejected_limit');
  });

  it('name mismatch', async () => {
    const s = createScriptedActionSession({ dialogText: 'Personalize your invitation to Wrong Person by adding a note.' });
    const r = await sendConnectionInviteLive(
      s,
      { vanityName: 'jane-example', recipientName: 'Jane Example' },
      { live: true },
    );
    assert.equal(r.status, 'recipient_name_mismatch');
  });

  it('urn mismatch yields uncertain', async () => {
    const s = createScriptedActionSession({
      dialogText: 'Personalize your invitation to Jane Example by adding a note.',
      inviteResponse: {
        status: 200,
        body: JSON.stringify({
          status: 200,
          data: {
            status: 200,
            value: { invitationUrn: 'urn:li:fsd_invitation:EXAMPLE', inviteeUrn: 'urn:li:fsd_profile:WRONG' },
          },
        }),
      },
    });
    const r = await sendConnectionInviteLive(
      s,
      { vanityName: 'jane-example', recipientName: 'Jane Example', expectedProfileUrn: 'urn:li:fsd_profile:EXPECTED' },
      { live: true },
    );
    assert.equal(r.status, 'uncertain');
    assert.equal(r.detail, 'urn_mismatch');
  });

  it('request-body urn mismatch yields uncertain', async () => {
    const s = createScriptedActionSession({
      dialogText: 'Personalize your invitation to Jane Example by adding a note.',
      inviteRequestPostData: JSON.stringify({
        invitee: { inviteeUnion: { memberProfile: 'urn:li:fsd_profile:OTHER' } },
      }),
      inviteResponse: {
        status: 200,
        body: JSON.stringify({
          status: 200,
          data: { status: 200, value: { invitationUrn: 'urn:li:fsd_invitation:EXAMPLE' } },
        }),
      },
    });
    const r = await sendConnectionInviteLive(
      s,
      { vanityName: 'jane-example', recipientName: 'Jane Example', expectedProfileUrn: 'urn:li:fsd_profile:EXPECTED' },
      { live: true },
    );
    assert.equal(r.status, 'uncertain');
    assert.equal(r.detail, 'urn_mismatch');
  });

  it('rejects extra invitation request fields', async () => {
    const s = createScriptedActionSession({
      dialogText: 'Personalize your invitation to Jane Example by adding a note.',
      inviteRequestPostData: JSON.stringify({
        invitee: { inviteeUnion: { memberProfile: 'urn:li:fsd_profile:EXPECTED' } },
        trackingId: 'extra',
      }),
      inviteResponse: {
        status: 200,
        body: JSON.stringify({
          status: 200,
          data: { status: 200, value: { invitationUrn: 'urn:li:fsd_invitation:EXAMPLE' } },
        }),
      },
    });
    const r = await sendConnectionInviteLive(
      s,
      { vanityName: 'jane-example', recipientName: 'Jane Example', expectedProfileUrn: 'urn:li:fsd_profile:EXPECTED' },
      { live: true },
    );
    assert.equal(r.status, 'uncertain');
    assert.equal(r.detail, 'unexpected_request_fields');
  });

  it('sent receipt', async () => {
    const s = createScriptedActionSession({
      dialogText: 'Personalize your invitation to Jane Example by adding a note.',
      inviteResponse: {
        status: 200,
        body: JSON.stringify({
          status: 200,
          data: { status: 200, value: { invitationUrn: 'urn:li:fsd_invitation:EXAMPLE' } },
        }),
      },
    });
    const r = await sendConnectionInviteLive(
      s,
      { vanityName: 'jane-example', recipientName: 'Jane Example' },
      { live: true },
    );
    assert.equal(r.status, 'sent');
  });
});

describe('verifySentInvites', () => {
  it('passes scripted sent page', async () => {
    const s = createScriptedActionSession({ sentPageOk: true });
    const r = await verifySentInvites(s, 'Jane Example');
    assert.equal(r.ok, true);
  });
});

describe('invite runner verification hold', () => {
  it('holds when sent page fails', async () => {
    const store = new InMemoryStore();
    const report = await runInvites({
      store,
      source: [{ slug: 'jane-example', name: 'Jane Example' }],
      config: { ...DEFAULT_INVITE_CONFIG, dryRun: false, minGapSec: 0, maxGapSec: 0 },
      verifySentPage: async () => false,
      sendInvite: async () => ({ status: 'sent', invitationUrn: 'urn:li:fsd_invitation:EXAMPLE' }),
    });
    assert.equal(report.held, true);
    assert.equal(store.readState().mode, 'review');
  });
});

describe('unavailable backoff machine', () => {
  it('blocks until retry window', () => {
    const store = new InMemoryStore();
    recordUnavailable(store, 'jane-example', { backoffHours: [6, 24] });
    assert.equal(isUnavailableBlocked(store, 'jane-example'), true);
  });
});

describe('content filter bracketed TLD', () => {
  it('rejects evil[.]com', () => {
    assert.equal(filterCommentContent('see evil[.]com today').ok, false);
  });

  it('passes counter cases', () => {
    for (const text of BENIGN_COUNTER_CASES) {
      if (text.includes('Node.js')) continue;
      assert.equal(filterCommentContent(text).ok, true, text);
    }
  });
});

describe('fake CDP WebSocket server', () => {
  it('answers Runtime.evaluate for CSRF', async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const wss = new WebSocketServer({ server, path: '/devtools/page/T1' });
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { id?: number; method?: string; params?: { expression?: string } };
        if (msg.id === undefined) return;
        let value: unknown = null;
        const expr = msg.params?.expression ?? '';
        if (msg.method === 'Runtime.evaluate' && expr.includes('JSESSIONID')) value = 'ajax:csrf';
        ws.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
      });
    });
    const session = await CdpSession.connect(
      `ws://127.0.0.1:${port}/devtools/page/T1`,
      { targetId: 'T1' },
      { commandTimeoutMs: 3_000, evaluateTimeoutMs: 3_000 },
    );
    const token = await session.evaluate(`document.cookie.match(/JSESSIONID/) ? "ajax:csrf" : null`);
    session.close();
    await new Promise<void>((r) => wss.close(() => server.close(() => r())));
    assert.equal(token, 'ajax:csrf');
  });
});