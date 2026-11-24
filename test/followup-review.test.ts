import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { InMemoryStore } from '../src/automation/core/store.js';
import { createNudgeDrafts, shouldCreateNudge } from '../src/automation/messaging/followup.js';
import { writePendingProposals } from '../src/automation/core/pending.js';
import { writeDrafts } from '../src/automation/messaging/queue.js';
import { startReviewServer } from '../src/ui/review-server.js';

describe('followup nudges', () => {
  it('creates capped nudge drafts without sending', () => {
    const root = mkdtempSync(join(tmpdir(), 'lcdp-follow-'));
    const store = new InMemoryStore();
    const sentAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const urn = 'urn:li:msg_conversation:(EXAMPLE)';
    assert.equal(shouldCreateNudge(store, urn, sentAt, { daysAfterSend: 4, maxNudgesPerThread: 2 }), true);
    const created = createNudgeDrafts(
      root,
      [{ conversationUrn: urn, ourLastSendAt: sentAt, hasInboundReplyAfterSend: false }],
      { daysAfterSend: 4, maxNudgesPerThread: 2 },
    );
    assert.equal(created.length, 1);
    assert.equal(created[0]?.status, 'pending');
    assert.match(created[0]?.text ?? '', /^nudge:/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('review server', () => {
  it('lists pending and enforces CSRF on POST', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lcdp-review-'));
    writePendingProposals(root, [
      {
        id: 'c1',
        slug: 'jane-doe',
        activityId: '123',
        text: 'Nice post',
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ]);
    writeDrafts(root, [
      { id: 'd1', conversationUrn: 'urn:li:msg:1', inboundFp: 'fp', text: 'draft', status: 'pending', createdAt: new Date().toISOString() },
    ]);
    const server = await startReviewServer({ stateDir: root, port: 0 });
    const pending = await fetch(`http://${server.host}:${server.port}/api/pending`);
    const body = (await pending.json()) as { comments: unknown[]; drafts: unknown[] };
    assert.ok(body.comments.length >= 1);
    assert.equal(body.drafts.length, 1);
    const denied = await fetch(`http://${server.host}:${server.port}/action`, { method: 'POST', body: 'kind=comment&id=c1&action=approve' });
    assert.equal(denied.status, 403);
    const ok = await fetch(`http://${server.host}:${server.port}/action`, {
      method: 'POST',
      headers: { 'x-review-csrf': server.token, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=comment&id=c1&action=approve',
    });
    assert.equal(ok.status, 200);
    const edited = await fetch(`http://${server.host}:${server.port}/action`, {
      method: 'POST',
      headers: { 'x-review-csrf': server.token, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'kind=draft&id=d1&action=edit&text=Rewritten+draft',
    });
    assert.equal(edited.status, 200);
    const after = (await (await fetch(`http://${server.host}:${server.port}/api/pending`)).json()) as {
      drafts: Array<{ id: string; text: string }>;
    };
    const replacement = after.drafts.find((draft) => draft.id !== 'd1' && draft.text === 'Rewritten draft');
    assert.ok(replacement);
    assert.match(replacement?.id ?? '', /^d1-edit-/);
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a non-loopback bind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lcdp-review-'));
    await assert.rejects(async () => startReviewServer({ stateDir: root, port: 0, host: '0.0.0.0' }), /loopback/);
    rmSync(root, { recursive: true, force: true });
  });
});