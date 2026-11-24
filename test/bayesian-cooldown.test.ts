import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BayesianCooldownPolicy,
  FixedCooldownPolicy,
  computeBayesianPosterior,
  type RateLimitObservation,
} from '../src/pipeline/cooldown.js';

describe('BayesianCooldownPolicy', () => {
  it('falls back to full window without observations', () => {
    const model = computeBayesianPosterior([]);
    assert.equal(model.scheduleStatus, 'fallback_no_receipts');
    assert.equal(model.conservativeHours, 168);
  });

  it('never unlocks from receipt alone when still inside conservative window', () => {
    const limitAt = '2026-01-01T00:00:00.000Z';
    const successAt = '2026-01-01T06:00:00.000Z';
    const obs: RateLimitObservation[] = [
      { firstLimitAt: limitAt },
      { evidenceQuality: 'receipt', receipt: 'r1', successfulAt: successAt },
    ];
    const policy = new BayesianCooldownPolicy(obs);
    const next = policy.nextEligibleAt({ slug: 'jane-doe' }, Date.parse('2026-01-02T00:00:00.000Z'));
    assert.ok(next !== null && next > Date.parse('2026-01-02T00:00:00.000Z'));
  });

  it('disagreeing observations fall back instead of unlocking', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const obs: RateLimitObservation[] = [
      { firstLimitAt: at },
      { evidenceQuality: 'receipt', receipt: 'r1', successfulAt: at },
    ];
    const model = computeBayesianPosterior(obs);
    assert.equal(model.scheduleStatus, 'fallback_invalid_evidence');
    assert.equal(model.conservativeHours, 168);
    const next = new BayesianCooldownPolicy(obs).nextEligibleAt(
      { slug: 'jane-doe' },
      Date.parse('2026-01-02T00:00:00.000Z'),
    );
    assert.ok(next !== null && next > Date.parse('2026-01-02T00:00:00.000Z'));
  });

  it('FixedCooldownPolicy remains default-style 7d', () => {
    const p = new FixedCooldownPolicy();
    const at = '2026-01-01T00:00:00.000Z';
    const next = p.nextEligibleAt({ slug: 'x', lastInviteAt: at }, Date.parse('2026-01-05T00:00:00.000Z'));
    assert.ok(next !== null);
  });
});