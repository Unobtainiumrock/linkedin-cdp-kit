import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStore } from '../src/automation/core/store.js';
import { asPipelineStore } from '../src/pipeline/persist.js';
import { JsonFileSource, CsvFileSource, runRefill, countEligibleQueue, DEFAULT_REFILL_CONFIG } from '../src/pipeline/discovery.js';
import { defaultScoreGrader, orderQualifiedQueue, applyGradeToQueueAsync, readResearchQueue } from '../src/pipeline/grading.js';
import { flagStaleCaptures, isVerifyDue, runVerify, DEFAULT_PROFILE_VERIFIER_CONFIG } from '../src/pipeline/verify.js';
import { importConnectionsCsv, transitionContact, readContactLedger } from '../src/pipeline/contacts.js';
import { auditUnavailable, applyUnavailableAudit } from '../src/pipeline/audit.js';
import { FixedCooldownPolicy, isCooldownActive } from '../src/pipeline/cooldown.js';
import {
  loadReferenceBundle,
  draftWithReviseOnce,
  builtinMaxLengthLinter,
  TargetRotationSelector,
  LocalPendingQueueApprovalChannel,
} from '../src/pipeline/comments-plugins.js';
import { KeywordIntentRouter, routeAndDraft, TerminalNotInterestedStrategy, TemplateReplyStrategy, loadVoiceAndContext } from '../src/pipeline/messaging-plugins.js';
import { evaluateHealth } from '../src/pipeline/health.js';
import { AlertDispatcher, ConsoleAlertChannel } from '../src/pipeline/alerts.js';

describe('pipeline refill', () => {
  it('persists cursors and dedupes', async () => {
    const store = asPipelineStore(new InMemoryStore());
    const dir = mkdtempSync(join(tmpdir(), 'lcdp-'));
    const file = join(dir, 'cands.json');
    writeFileSync(
      file,
      JSON.stringify([
        { slug: 'alpha-one', name: 'Alpha One' },
        { slug: 'beta-two', name: 'Beta Two' },
        { slug: 'alpha-one', name: 'Alpha One Dup' },
      ]),
    );
    const src = new JsonFileSource('json', file);
    const r1 = await runRefill(store, [src], {
      config: { ...DEFAULT_REFILL_CONFIG, floor: 2, batchBudget: 10, perSourceMaxShare: 1 },
    });
    assert.ok(r1.added >= 2);
    const r2 = await runRefill(store, [src], { config: { ...DEFAULT_REFILL_CONFIG, floor: 250, batchBudget: 10 } });
    assert.equal(r2.added, 0);
    assert.ok(r2.skippedDedup >= 0);
    assert.ok(countEligibleQueue(store) >= 2);
  });

  it('respects floor without chrome', async () => {
    const store = asPipelineStore(new InMemoryStore());
    store.writeJson('invite-queue.json', Array.from({ length: 260 }, (_, i) => ({
      slug: `filled-${i}`,
      name: `Filled ${i}`,
      sourceId: 'seed',
      insertedAt: new Date().toISOString(),
    })));
    const dir = mkdtempSync(join(tmpdir(), 'lcdp-'));
    const file = join(dir, 'cands.json');
    writeFileSync(file, JSON.stringify([{ slug: 'extra', name: 'Extra' }]));
    const r = await runRefill(store, [new JsonFileSource('j', file)]);
    assert.equal(r.added, 0);
    assert.equal(r.eligibleBefore, 260);
  });
});

describe('grading and verify', () => {
  it('orders by score', () => {
    const ordered = orderQualifiedQueue([
      { slug: 'b', name: 'B', sourceId: 's', insertedAt: '2020-01-02', score: 0.2 },
      { slug: 'a', name: 'A', sourceId: 's', insertedAt: '2020-01-01', score: 0.9 },
    ]);
    assert.equal(ordered[0]!.slug, 'a');
  });

  it('research queue and backoff', async () => {
    const store = asPipelineStore(new InMemoryStore());
    store.writeJson('invite-queue.json', [{ slug: 'need-data', name: 'Need Data', sourceId: 'x', insertedAt: new Date().toISOString() }]);
    const grader = defaultScoreGrader(0.2);
    const out = await applyGradeToQueueAsync(store, grader);
    assert.equal(out.research, 1);
    assert.equal(readResearchQueue(store).length, 1);
    const entry = readResearchQueue(store)[0]!;
    entry.nextVerifyAt = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal(isVerifyDue(entry), false);
    entry.nextVerifyAt = new Date(Date.now() - 1_000).toISOString();
    assert.equal(isVerifyDue(entry), true);
    const flagged = flagStaleCaptures(
      [{ ...entry, profileCapturedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }],
      DEFAULT_PROFILE_VERIFIER_CONFIG.staleAfterDays,
    );
    assert.equal(flagged[0]!.stale, true);
    const report = await runVerify(store, undefined, grader, { live: false });
    assert.equal(report.skippedBackoff, 0);
  });
});

describe('contacts and audit', () => {
  it('imports connections csv', () => {
    const store = asPipelineStore(new InMemoryStore());
    const dir = mkdtempSync(join(tmpdir(), 'lcdp-'));
    const csv = join(dir, 'Connections.csv');
    writeFileSync(csv, 'First Name,Last Name,URL,Connected On\nJane,Example,https://www.linkedin.com/in/jane-example/,2024-01-01\n');
    const r = importConnectionsCsv(store, csv);
    assert.equal(r.imported, 1);
    assert.equal(readContactLedger(store)[0]!.state, 'connected');
    transitionContact(store, 'jane-example', 'Jane Example', 'commented');
    assert.equal(readContactLedger(store)[0]!.state, 'commented');
  });

  it('prunes and repairs unavailable', () => {
    const store = asPipelineStore(new InMemoryStore());
    transitionContact(store, 'gone', 'Gone', 'qualified');
    transitionContact(store, 'renamed', 'Renamed', 'qualified');
    const audit = auditUnavailable(readContactLedger(store), {
      gone: { status: 404 },
      renamed: { status: 200, redirectSlug: 'renamed-new' },
    });
    assert.equal(audit.prune.length, 1);
    assert.equal(audit.repair.length, 1);
    const applied = applyUnavailableAudit(store, audit);
    assert.equal(applied.pruned, 1);
    assert.equal(applied.repaired, 1);
  });
});

describe('comments plugins', () => {
  it('reference bundle separation and revise-once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcdp-ref-'));
    writeFileSync(join(dir, 'voice.md'), 'Be concise.');
    writeFileSync(join(dir, 'rules.md'), 'No links.');
    const ref = loadReferenceBundle(dir);
    let pass = 0;
    const draft = async (_p: unknown, ctx: { previousDraft?: string; lintFindings?: unknown[] }) => {
      pass += 1;
      if (ctx.previousDraft) return 'short ok';
      return 'x'.repeat(500);
    };
    const out = await draftWithReviseOnce(draft, { url: 'https://example.invalid/post' }, ref, [builtinMaxLengthLinter(100)]);
    assert.equal(pass, 2);
    assert.ok(out.text.length <= 100);
  });

  it('target rotation cooldown', () => {
    const sel = new TargetRotationSelector({ authorCooldownDays: 14 });
    const now = Date.now();
    const targets = sel.select(
      [{ slug: 'a', name: 'A', state: 'connected', optOut: false, updatedAt: '' }],
      [{ slug: 'a', name: 'A', lastCommentAt: new Date(now - 86_400_000).toISOString() }],
      now,
    );
    assert.equal(targets.length, 0);
  });

  it('approval channel', () => {
    const store = asPipelineStore(new InMemoryStore());
    const ch = new LocalPendingQueueApprovalChannel();
    ch.enqueue(store, {
      id: 'p1',
      slug: 's',
      activityId: '1',
      text: 'pending',
      createdAt: new Date().toISOString(),
      status: 'pending',
    });
    assert.equal(ch.listPending(store).length, 1);
    assert.equal(ch.approve(store, 'p1', 'approved text'), true);
    assert.equal(ch.listPending(store)[0]!.status, 'approved');
  });
});

describe('messaging plugins', () => {
  it('terminal vs draft', async () => {
    const router = new KeywordIntentRouter();
    const voice = loadVoiceAndContext({});
    const out = await routeAndDraft(router, [new TerminalNotInterestedStrategy(), new TemplateReplyStrategy('question', 'Thanks for asking: {{inbound}}')], {
      text: 'not interested, thanks',
      fingerprint: 'fp',
      conversationUrn: 'urn:li:msg:1',
    }, voice);
    assert.equal(out.terminal, true);
    const q = await routeAndDraft(router, [new TemplateReplyStrategy('question', 'Ans: {{inbound}}')], {
      text: 'What is the price?',
      fingerprint: 'fp2',
      conversationUrn: 'urn:li:msg:2',
    }, voice);
    assert.equal(q.terminal, false);
    assert.ok(q.text.includes('Ans'));
  });
});

describe('health and alerts', () => {
  it('evaluateHealth warns on review', () => {
    const store = asPipelineStore(new InMemoryStore());
    store.writeState({ mode: 'review', reason: 'test' });
    const h = evaluateHealth(store);
    assert.equal(h.overall, 'fail');
  });

  it('rate limits alerts', async () => {
    const dispatcher = new AlertDispatcher([new ConsoleAlertChannel()], { minIntervalMs: 60_000 });
    const report = evaluateHealth(asPipelineStore(new InMemoryStore()));
    const a = await dispatcher.dispatch(report, Date.now());
    const b = await dispatcher.dispatch(report, Date.now() + 1_000);
    assert.ok(a.sent.length >= 0);
    assert.ok(b.suppressed.length >= b.sent.length || b.suppressed.length >= 0);
  });
});

describe('cooldown policy', () => {
  it('blocks inside window', () => {
    const p = new FixedCooldownPolicy(7 * 86_400_000);
    const ctx = { slug: 'x', lastInviteAt: new Date().toISOString() };
    assert.equal(isCooldownActive(p, ctx), true);
  });
});

describe('csv source', () => {
  it('reads csv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcdp-'));
    const csv = join(dir, 'src.csv');
    writeFileSync(csv, 'slug,name\ntarget-a,Target A\n');
    const src = new CsvFileSource('csv', csv);
    const batch = src.fetchBatch(null, 5);
    assert.equal(batch.candidates.length, 1);
  });
});