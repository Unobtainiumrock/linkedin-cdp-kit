import { asPipelineStore, type PipelineStore } from './persist.js';
import { countEligibleQueue } from './discovery.js';
import { readResearchQueue } from './grading.js';
import { DEFAULT_REFILL_CONFIG } from './discovery.js';
import type { Store } from '../automation/core/store.js';

export type StoreLike = Store | PipelineStore;

export type HealthState = 'ok' | 'warn' | 'fail';

export type HealthCheck = {
  key: string;
  state: HealthState;
  detail: string;
  fixHint?: string;
};

export type HealthReport = {
  overall: HealthState;
  checks: HealthCheck[];
};

function worst(states: HealthState[]): HealthState {
  if (states.includes('fail')) return 'fail';
  if (states.includes('warn')) return 'warn';
  return 'ok';
}

export function evaluateHealth(store: StoreLike, now = Date.now()): HealthReport {
  const ps = asPipelineStore(store);
  const checks: HealthCheck[] = [];
  const runtime = ps.readState();
  const ledger = ps.readLedger();
  const qualified = ps.readJson<unknown[]>('invite-qualified.json', []);
  const queueCount = countEligibleQueue(ps);
  const floor = DEFAULT_REFILL_CONFIG.floor;

  if (runtime.mode === 'ready' && !runtime.killSwitch) {
    const recentSent = ledger.filter((r) => r.status === 'sent' && now - Date.parse(r.at) < 7 * 86_400_000);
    if (recentSent.length === 0 && qualified.length > 0) {
      checks.push({
        key: 'invites_silent',
        state: 'warn',
        detail: 'Ready but no recent sent invites',
        fixHint: 'Run invites run or check qualify pipeline',
      });
    }
  }

  if (queueCount + qualified.length < floor * 0.5) {
    checks.push({
      key: 'qualified_floor',
      state: 'warn',
      detail: `Qualified+queue ${queueCount + qualified.length} below half of floor ${floor}`,
      fixHint: 'Run pipeline refill',
    });
  }

  const attempting = ledger.filter((r) => r.status === 'attempting');
  if (attempting.length > 0) {
    const stale = attempting.filter((r) => now - Date.parse(r.at) > 3_600_000);
    checks.push({
      key: 'stuck_attempting',
      state: stale.length > 0 ? 'fail' : 'warn',
      detail: `${attempting.length} attempting row(s)`,
      fixHint: 'Clear reserve or resume after manual review',
    });
  }

  if (runtime.mode === 'review') {
    checks.push({
      key: 'review_hold',
      state: 'fail',
      detail: runtime.reason ?? 'review hold active',
      fixHint: 'Resolve hold then invites resume',
    });
  }

  if (runtime.mode === 'cooldown') {
    checks.push({
      key: 'cooldown',
      state: 'warn',
      detail: 'Invite lane in cooldown',
      fixHint: 'Wait for cooldown expiry',
    });
  }

  const research = readResearchQueue(ps);
  const dueVerify = research.filter((r) => !r.nextVerifyAt || Date.parse(r.nextVerifyAt) <= now);
  if (dueVerify.length > 5) {
    checks.push({
      key: 'verify_backlog',
      state: 'warn',
      detail: `${dueVerify.length} research entries due for verify`,
      fixHint: 'Run verify',
    });
  }

  const staleResearch = research.filter((r) => r.stale);
  if (staleResearch.length > 0) {
    checks.push({
      key: 'stale_captures',
      state: 'warn',
      detail: `${staleResearch.length} stale profile captures`,
      fixHint: 'Re-run verify with live fetch',
    });
  }

  const commentFails = ledger.filter((r) => r.status === 'manual_review' && String(r['lane']) === 'comments');
  if (commentFails.length >= 2) {
    checks.push({
      key: 'comment_circuit',
      state: 'fail',
      detail: 'Comment circuit breaker tripped',
      fixHint: 'Inspect pending comments and ledger',
    });
  }

  if (checks.length === 0) {
    checks.push({ key: 'overall', state: 'ok', detail: 'All lanes nominal' });
  }

  return { overall: worst(checks.map((c) => c.state)), checks };
}