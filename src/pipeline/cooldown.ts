export type CooldownContext = {
  slug: string;
  lastInviteAt?: string;
  limitHitAt?: string;
};

export interface CooldownPolicy {
  readonly id: string;
  nextEligibleAt(ctx: CooldownContext, now?: number): number | null;
}

export class FixedCooldownPolicy implements CooldownPolicy {
  readonly id = 'fixed_7d';
  constructor(private readonly windowMs = 7 * 86_400_000) {}

  nextEligibleAt(ctx: CooldownContext, now = Date.now()): number | null {
    const last = ctx.lastInviteAt ? Date.parse(ctx.lastInviteAt) : 0;
    if (!last) return null;
    const unlock = last + this.windowMs;
    return unlock > now ? unlock : null;
  }
}

export class LimitHitCooldownPolicy implements CooldownPolicy {
  readonly id = 'limit_hit_7d';
  constructor(private readonly windowMs = 7 * 86_400_000) {}

  nextEligibleAt(ctx: CooldownContext, now = Date.now()): number | null {
    const hit = ctx.limitHitAt ? Date.parse(ctx.limitHitAt) : 0;
    if (!hit) return null;
    const unlock = hit + this.windowMs;
    return unlock > now ? unlock : null;
  }
}

export function isCooldownActive(policy: CooldownPolicy, ctx: CooldownContext, now = Date.now()): boolean {
  const next = policy.nextEligibleAt(ctx, now);
  return next !== null;
}

export type RateLimitObservation = {
  firstLimitAt?: string;
  at?: string;
  response?: string;
  observationType?: string;
  reportedAt?: string;
  manualSuccessfulInvitations?: number;
  evidenceQuality?: string;
  receipt?: string;
  successfulAt?: string;
};

const WINDOW_HOURS = 7 * 24;
const GRID: number[] = Array.from({ length: WINDOW_HOURS + 1 }, (_, i) => i);
const CONSERVATIVE_QUANTILE = 0.95;
const WEAK_EVIDENCE_WEIGHT = 0.25;
const CONSERVATIVE_FALLBACK_MS = WINDOW_HOURS * 3_600_000;

function parseIso(value: string): number {
  return Date.parse(value.replace(/Z$/, '+00:00'));
}

type EpisodeEvidence = {
  baselineMs: number;
  lowerHours: number;
  weakUpperHours: number | null;
  strongUpperHours: number | null;
  limitCount: number;
  strongSuccessCount: number;
};

function buildEvidence(rows: RateLimitObservation[]): EpisodeEvidence | null {
  const limits: number[] = [];
  const weakSuccesses: number[] = [];
  const strongSuccesses: number[] = [];
  for (const row of rows) {
    if (row.firstLimitAt) limits.push(parseIso(row.firstLimitAt));
    const response = String(row.response ?? '');
    if (response.includes('FUSE_LIMIT_EXCEEDED') && row.at) limits.push(parseIso(row.at));
    if (row.observationType === 'owner_report' && row.reportedAt) {
      if ((row.manualSuccessfulInvitations ?? 0) > 0) weakSuccesses.push(parseIso(row.reportedAt));
    }
    if (row.evidenceQuality === 'receipt' && row.receipt && row.successfulAt) {
      strongSuccesses.push(parseIso(row.successfulAt));
    }
  }
  if (limits.length === 0) return null;
  const limitSet = new Set(limits);
  const successSet = new Set(strongSuccesses);
  const events: Array<[number, 0 | 1]> = [];
  for (const t of new Set([...limits, ...strongSuccesses])) {
    if (limitSet.has(t)) events.push([t, 0]);
    if (successSet.has(t)) events.push([t, 1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  type Episode = { baseline: number; lastLimitAt: number; successAt: number | null; limitCount: number };
  let active: Episode | null = null;
  const episodes: Episode[] = [];
  for (const [at, kind] of events) {
    if (kind === 0) {
      if (!active) {
        active = { baseline: at, lastLimitAt: at, successAt: null, limitCount: 0 };
        episodes.push(active);
      }
      active.lastLimitAt = at;
      active.limitCount += 1;
    } else if (active) {
      active.successAt = at;
      active = null;
    }
  }
  const episode = episodes[episodes.length - 1];
  if (!episode) return null;
  const baseline = episode.baseline;
  const success = episode.successAt;
  const lowerHours = Math.max(0, (episode.lastLimitAt - baseline) / 3_600_000);
  const weak = weakSuccesses.filter((t) => t >= baseline && (success === null || t <= success));
  const weakUpper = weak.length > 0 ? Math.min(...weak.map((t) => (t - baseline) / 3_600_000)) : null;
  const strongUpper = success !== null ? (success - baseline) / 3_600_000 : null;
  return {
    baselineMs: baseline,
    lowerHours,
    weakUpperHours: weakUpper,
    strongUpperHours: strongUpper,
    limitCount: episode.limitCount,
    strongSuccessCount: success !== null ? 1 : 0,
  };
}

function weightedQuantile(weights: number[], q: number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return WINDOW_HOURS;
  const threshold = total * q;
  let cumulative = 0;
  for (let i = 0; i < GRID.length; i++) {
    cumulative += weights[i] ?? 0;
    if (cumulative >= threshold) return GRID[i] ?? WINDOW_HOURS;
  }
  return WINDOW_HOURS;
}

export type BayesianPosterior = {
  conservativeHours: number;
  scheduleStatus: string;
  availabilityConservativeHours: number | null;
};

export function computeBayesianPosterior(observations: RateLimitObservation[]): BayesianPosterior {
  const evidence = buildEvidence(observations);
  if (!evidence) {
    return {
      conservativeHours: WINDOW_HOURS,
      scheduleStatus: 'fallback_no_receipts',
      availabilityConservativeHours: null,
    };
  }
  const strongWeights: number[] = GRID.map((hour) => {
    if (hour <= evidence.lowerHours) return 0;
    if (evidence.strongUpperHours !== null && hour > evidence.strongUpperHours) return 0;
    return 1;
  });
  const weighted: number[] = GRID.map((hour, i) => {
    let w = strongWeights[i] ?? 0;
    if (evidence.weakUpperHours !== null && hour <= evidence.weakUpperHours) w *= 1 + WEAK_EVIDENCE_WEIGHT;
    return w;
  });
  const strongTotal = strongWeights.reduce<number>((a, b) => a + b, 0);
  const weightedTotal = weighted.reduce<number>((a, b) => a + b, 0);
  const valid = strongTotal > 0 && weightedTotal > 0;
  if (!valid) {
    return {
      conservativeHours: WINDOW_HOURS,
      scheduleStatus: 'fallback_invalid_evidence',
      availabilityConservativeHours: null,
    };
  }
  const availabilityConservativeHours = weightedQuantile(strongWeights, CONSERVATIVE_QUANTILE);
  return {
    conservativeHours: WINDOW_HOURS,
    scheduleStatus: evidence.strongSuccessCount ? 'fallback_full_reset_unproven' : 'fallback_no_receipts',
    availabilityConservativeHours,
  };
}

export class BayesianCooldownPolicy implements CooldownPolicy {
  readonly id = 'bayesian_episode';
  constructor(
    private readonly observations: RateLimitObservation[],
    private readonly fallbackMs = CONSERVATIVE_FALLBACK_MS,
  ) {}

  nextEligibleAt(ctx: CooldownContext, now = Date.now()): number | null {
    void ctx;
    const model = computeBayesianPosterior(this.observations);
    const hits = this.observations
      .flatMap((r) => {
        const out: number[] = [];
        if (r.firstLimitAt) out.push(parseIso(r.firstLimitAt));
        if (r.response?.includes('FUSE_LIMIT_EXCEEDED') && r.at) out.push(parseIso(r.at));
        return out;
      })
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a);
    const hit = hits[0];
    if (!hit) return null;
    const policyHours = model.conservativeHours;
    const policyUnlock = hit + policyHours * 3_600_000;
    const receiptHours = model.availabilityConservativeHours;
    const receiptUnlock =
      receiptHours !== null ? hit + receiptHours * 3_600_000 : policyUnlock;
    const unlock = Math.max(policyUnlock, receiptUnlock, hit + this.fallbackMs);
    return unlock > now ? unlock : null;
  }
}