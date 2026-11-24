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