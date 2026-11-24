import type { Store } from '../core/store.js';

export type UnavailableBackoffConfig = {
  backoffHours: number[];
};

const DEFAULT_BACKOFF: UnavailableBackoffConfig = {
  backoffHours: [6, 24],
};

export type UnavailableState = {
  slug: string;
  attempts: number;
  nextRetryAt?: string;
  closed?: boolean;
};

export function loadUnavailable(store: Store, slug: string): UnavailableState | null {
  const row = store.readLedger().filter((r) => r.slug === slug && r.unavailableTrack);
  const last = row[row.length - 1];
  if (!last) return null;
  return {
    slug,
    attempts: Number(last.unavailableAttempts ?? 0),
    nextRetryAt: typeof last.nextRetryAt === 'string' ? last.nextRetryAt : undefined,
    closed: Boolean(last.unavailableClosed),
  };
}

export function recordUnavailable(
  store: Store,
  slug: string,
  cfg: UnavailableBackoffConfig = DEFAULT_BACKOFF,
): UnavailableState {
  const prev = loadUnavailable(store, slug);
  const attempts = (prev?.attempts ?? 0) + 1;
  const maxIdx = cfg.backoffHours.length - 1;
  const hours = cfg.backoffHours[Math.min(attempts - 1, maxIdx)] ?? cfg.backoffHours[maxIdx] ?? 24;
  const closed = attempts > cfg.backoffHours.length;
  const nextRetryAt = closed ? undefined : new Date(Date.now() + hours * 3_600_000).toISOString();
  store.appendLedger({
    status: closed ? 'unavailable_closed' : 'unavailable',
    slug,
    unavailableTrack: true,
    unavailableAttempts: attempts,
    nextRetryAt,
    unavailableClosed: closed,
  });
  return { slug, attempts, nextRetryAt, closed };
}

export function isUnavailableBlocked(store: Store, slug: string, now = Date.now()): boolean {
  const state = loadUnavailable(store, slug);
  if (!state || state.closed) return state?.closed === true;
  if (!state.nextRetryAt) return false;
  return now < Date.parse(state.nextRetryAt);
}