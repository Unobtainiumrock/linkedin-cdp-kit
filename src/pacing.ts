export type RateLimitStore = {
  record(timestampMs: number): void;
  countInWindow(windowMs: number, nowMs?: number): number;
  reset?(): void;
};

export class InMemoryRateLimitStore implements RateLimitStore {
  private timestamps: number[] = [];

  record(timestampMs: number): void {
    this.timestamps.push(timestampMs);
  }

  countInWindow(windowMs: number, nowMs = Date.now()): number {
    const cutoff = nowMs - windowMs;
    this.timestamps = this.timestamps.filter((t) => t >= cutoff);
    return this.timestamps.length;
  }

  reset(): void {
    this.timestamps = [];
  }
}

export type RateLimiterOptions = {
  windowMs: number;
  maxActions: number;
  store?: RateLimitStore;
};

export class RollingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxActions: number;
  private readonly store: RateLimitStore;

  constructor(opts: RateLimiterOptions) {
    this.windowMs = opts.windowMs;
    this.maxActions = opts.maxActions;
    this.store = opts.store ?? new InMemoryRateLimitStore();
  }

  canProceed(nowMs = Date.now()): boolean {
    return this.store.countInWindow(this.windowMs, nowMs) < this.maxActions;
  }

  record(nowMs = Date.now()): void {
    this.store.record(nowMs);
  }

  async waitIfNeeded(nowMs = Date.now()): Promise<void> {
    if (this.canProceed(nowMs)) return;
    const waitMs = Math.min(this.windowMs, 5_000);
    await jitteredDelay(waitMs, waitMs + 500);
  }
}

export function jitteredDelay(minMs: number, maxMs: number): Promise<void> {
  if (process.env['LINKEDIN_CDP_FAST_NAV'] === '1' || maxMs === 0) {
    return Promise.resolve();
  }
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  const ms = lo + Math.random() * (hi - lo);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type UncertainOutcome = 'manual_review' | 'uncertain';

/**
 * After an uncertain post-click outcome, callers must stop and not auto-retry.
 */
export function assertNoAutoRetryAfterUncertain(outcome: UncertainOutcome | 'posted' | 'sent' | 'dry_run'): void {
  if (outcome === 'manual_review' || outcome === 'uncertain') {
    throw new Error(
      'Uncertain outcome — do not auto-retry. Inspect the page manually before attempting again.',
    );
  }
}