import type { GateResult, RuntimeState } from './types.js';
import type { Store } from './store.js';
import { isWithinAllowedHours, type AllowedHoursConfig } from './time-window.js';

export type GateConfig = {
  killSwitch?: boolean;
  allowedHours?: AllowedHoursConfig;
  rollingWindowMs?: number;
  rollingMaxActions?: number;
  runBudgetMs?: number;
  runStartedAt?: number;
  now?: Date;
};

const ATTEMPTING = new Set(['attempting']);

export function hasUnresolvedAttempts(store: Store): boolean {
  return store.readLedger().some((r) => ATTEMPTING.has(String(r.status)));
}

export function countInRollingWindow(store: Store, windowMs: number, nowMs: number, statusFilter?: Set<string>): number {
  const cutoff = nowMs - windowMs;
  return store.readLedger().filter((r) => {
    if (statusFilter && !statusFilter.has(String(r.status))) return false;
    const at = Date.parse(String(r.at));
    return Number.isFinite(at) && at >= cutoff;
  }).length;
}

export function evaluateGates(store: Store, cfg: GateConfig = {}): GateResult {
  const now = cfg.now ?? new Date();
  const nowMs = now.getTime();
  const state = store.readState();

  if (cfg.killSwitch || state.killSwitch) {
    return { ok: false, code: 'kill_switch', detail: 'Kill switch is on' };
  }

  if (state.mode === 'review') {
    return { ok: false, code: 'review_hold', detail: state.reviewReason ?? state.reason ?? 'review' };
  }

  if (state.mode === 'cooldown' && state.cooldownUntil) {
    if (nowMs < Date.parse(state.cooldownUntil)) {
      return { ok: false, code: 'cooldown', detail: state.cooldownUntil };
    }
  }

  if (hasUnresolvedAttempts(store)) {
    return { ok: false, code: 'unresolved_attempting', detail: 'Ledger has attempting rows' };
  }

  if (cfg.allowedHours && !isWithinAllowedHours(now, cfg.allowedHours)) {
    return { ok: false, code: 'outside_allowed_hours' };
  }

  if (cfg.rollingWindowMs && cfg.rollingMaxActions !== undefined) {
    const count = countInRollingWindow(store, cfg.rollingWindowMs, nowMs, new Set(['sent', 'posted']));
    if (count >= cfg.rollingMaxActions) {
      return { ok: false, code: 'rolling_cap', detail: `${count}/${cfg.rollingMaxActions}` };
    }
  }

  if (cfg.runBudgetMs && cfg.runStartedAt !== undefined) {
    if (nowMs - cfg.runStartedAt > cfg.runBudgetMs) {
      return { ok: false, code: 'time_budget', detail: String(cfg.runBudgetMs) };
    }
  }

  if (state.mode === 'paused') {
    return { ok: false, code: 'paused', detail: state.reason };
  }

  return { ok: true };
}

export function enterReviewHold(store: Store, reason: string): void {
  const prev = store.readState();
  store.writeState({
    ...prev,
    mode: 'review',
    reviewReason: reason,
    since: new Date().toISOString(),
  });
}

export function enterCooldown(store: Store, untilIso: string, reason: string): void {
  store.writeState({
    ...store.readState(),
    mode: 'cooldown',
    cooldownUntil: untilIso,
    reason,
    since: new Date().toISOString(),
  });
}

export function resumeFromReview(store: Store, reason: string): RuntimeState {
  const next: RuntimeState = {
    ...store.readState(),
    mode: 'ready',
    reviewReason: undefined,
    reason: `resumed: ${reason}`,
    since: new Date().toISOString(),
  };
  store.writeState(next);
  return next;
}