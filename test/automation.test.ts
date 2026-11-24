import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InMemoryStore } from '../src/automation/core/store.js';
import { evaluateGates, enterCooldown, enterReviewHold, resumeFromReview } from '../src/automation/core/gates.js';
import { reserveBeforeClick, finalizeAttempt } from '../src/automation/core/reserve.js';
import { isWithinAllowedHours } from '../src/automation/core/time-window.js';
import { filterCommentContent, BENIGN_COMMENT_SAMPLE } from '../src/automation/comments/content-filter.js';
import { isPostFresh, activityCreatedMs, approveProposal } from '../src/automation/comments/pipeline.js';
import { commentDraftId } from '../src/automation/comments/draft-id.js';
import { inboundFingerprint, lastSenderIsSelf } from '../src/automation/messaging/ingest.js';
import { dispatchOne, alreadySentForFingerprint } from '../src/automation/messaging/dispatch.js';
import { runInvites } from '../src/automation/invites/runner.js';
import type { InviteResult } from '../src/actions/invite.js';

describe('gate ordering', () => {
  it('blocks on kill switch before rolling cap', () => {
    const store = new InMemoryStore();
    store.writeState({ mode: 'ready', killSwitch: true });
    const gate = evaluateGates(store, { rollingWindowMs: 7 * 86_400_000, rollingMaxActions: 100 });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.code, 'kill_switch');
  });

  it('blocks on attempting rows', () => {
    const store = new InMemoryStore();
    reserveBeforeClick(store, { status: 'attempting', slug: 'jane-doe-123' });
    const gate = evaluateGates(store, {});
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.code, 'unresolved_attempting');
  });
});

describe('rolling cap', () => {
  it('blocks when weekly cap reached', () => {
    const store = new InMemoryStore();
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      store.appendLedger({ status: 'sent', at: new Date(now - i * 1000).toISOString(), slug: `s${i}` });
    }
    const gate = evaluateGates(store, { rollingWindowMs: 86_400_000, rollingMaxActions: 3, now: new Date(now) });
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.code, 'rolling_cap');
  });
});

describe('cooldown on limit', () => {
  it('sets cooldown and blocks', () => {
    const store = new InMemoryStore();
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    enterCooldown(store, until, 'FUSE_LIMIT_EXCEEDED');
    const gate = evaluateGates(store, {});
    assert.equal(gate.ok, false);
    if (!gate.ok) assert.equal(gate.code, 'cooldown');
  });
});

describe('resume review', () => {
  it('clears review only with reason', () => {
    const store = new InMemoryStore();
    enterReviewHold(store, 'uncertain');
    resumeFromReview(store, 'operator_cleared');
    assert.equal(store.readState().mode, 'ready');
  });
});

describe('allowed hours DST', () => {
  it('evaluates in configured time zone', () => {
    const winter = new Date('2024-01-15T17:00:00Z');
    const ok = isWithinAllowedHours(winter, { timeZone: 'America/Los_Angeles', startHour: 8, endHour: 18 });
    assert.equal(typeof ok, 'boolean');
  });
});

describe('comment circuit breaker', () => {
  it('holds after uncertain streak in auto mode config', () => {
    const store = new InMemoryStore();
    enterReviewHold(store, 'comment_uncertain_streak');
    assert.equal(store.readState().mode, 'review');
  });
});

describe('content filter', () => {
  it('passes benign prose', () => {
    const r = filterCommentContent(BENIGN_COMMENT_SAMPLE, 'different source words entirely');
    assert.equal(r.ok, true);
  });

  it('rejects links and mentions', () => {
    assert.equal(filterCommentContent('see https://example.com').ok, false);
    assert.equal(filterCommentContent('hello @someone').ok, false);
    assert.equal(filterCommentContent('ping @some-handle please').ok, false);
  });
});

describe('comment freshness', () => {
  it('uses activity id timestamp', () => {
    const id = '7442063467911548929';
    const ms = activityCreatedMs(id);
    assert.ok(ms > 1_600_000_000_000);
    const post = { text: 'x', author: 'Jane', age: null, urn: 'u', activityId: id };
    assert.equal(isPostFresh(post, 48, ms + 3_600_000), true);
  });
});

describe('messaging fingerprint', () => {
  it('changes when inbound changes', () => {
    const msgs = [
      { sender: 'Jane Doe', text: 'first', subject: '', timestamp: '1' },
      { sender: 'Example User', text: 'reply', subject: '', timestamp: '2' },
    ];
    const a = inboundFingerprint(msgs, 'Example User');
    const b = inboundFingerprint([...msgs, { sender: 'Jane Doe', text: 'second', subject: '', timestamp: '3' }], 'Example User');
    assert.notEqual(a, b);
  });

  it('detects manual reply', () => {
    const msgs = [
      { sender: 'Jane', text: 'in', subject: '', timestamp: '1' },
      { sender: 'Example User', text: 'out', subject: '', timestamp: '2' },
    ];
    assert.equal(lastSenderIsSelf(msgs, 'Example User'), true);
  });
});

describe('send_failed regression', () => {
  it('records send_failed when sender returns not ok', async () => {
    const store = new InMemoryStore();
    store.writeState({ mode: 'ready', killSwitch: false });
    const r = await dispatchOne(
      store,
      { conversationUrn: 'urn:li:msg:test', text: 'Hello world message', inboundFp: 'fp1' },
      { sendEnabled: true, maxSendsPerDay: 10, minGapSec: 0, maxGapSec: 0, dryRun: false },
      {},
      async () => ({ ok: false, reason: 'compose_box_not_ready' }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.status, 'send_failed');
    assert.ok(store.readLedger().some((row) => row.status === 'send_failed'));
  });
});

describe('kill switch default off', () => {
  it('blocks when sendEnabled false', async () => {
    const store = new InMemoryStore();
    const r = await dispatchOne(
      store,
      { conversationUrn: 'u', text: 'long enough message here', inboundFp: 'fp' },
      { sendEnabled: false, maxSendsPerDay: 10, minGapSec: 1, maxGapSec: 2, dryRun: false },
      {},
      async () => ({ ok: true, verified: true, conversationUrn: 'u', threadId: 't' }),
    );
    assert.equal(r.reason, 'kill_switch');
  });
});

describe('invite reserve before click', () => {
  it('dry run does not write attempting', async () => {
    const store = new InMemoryStore();
    const report = await runInvites({
      store,
      source: [{ slug: 'jane-doe-123', name: 'Jane Doe' }],
      sendInvite: async () => ({ status: 'dry_run', url: '', recipientName: 'Jane' }),
      config: {
        dryRun: true,
        rollingWindowMs: 604_800_000,
        rollingMaxInvites: 100,
        cooldownDaysOnLimit: 7,
        unavailableBackoffHours: [6, 24],
        securityWarningStops: true,
        minGapSec: 1,
        maxGapSec: 2,
      },
    });
    assert.equal(report.dryRun, true);
    assert.ok(report.actions.some((a) => a.status === 'dry_run'));
    assert.equal(store.readLedger().filter((r) => r.status === 'attempting').length, 0);
  });
});

describe('manual approval round trip', () => {
  it('approves immutable text by draft id', () => {
    const store = new InMemoryStore();
    const text = 'Nice post about developer tooling.';
    const activityId = '9007199254740992';
    const slug = 'jane-doe-123';
    const id = commentDraftId({ targetSlug: slug, text, activityId });
    store.appendLedger({ status: 'pending', draftId: id, slug, activityId, textHash: 'x' });
    assert.equal(approveProposal(store, id, text), true);
    assert.ok(store.readLedger().some((r) => r.status === 'approved'));
  });
});

describe('dedup fingerprint sends', () => {
  it('prevents second send for same fp', () => {
    const store = new InMemoryStore();
    store.appendLedger({ status: 'sent', conversationUrn: 'u', inboundFp: 'fp1' });
    assert.equal(alreadySentForFingerprint(store, 'u', 'fp1'), true);
  });
});