import type { Store } from './store.js';
import type { LedgerRow } from './types.js';
import { assertNoAutoRetryAfterUncertain } from '../../pacing.js';

export type ReserveOutcome = 'sent' | 'posted' | 'rejected_limit' | 'rejected_resend' | 'uncertain' | 'failed' | string;

export function reserveBeforeClick(
  store: Store,
  row: Omit<LedgerRow, 'id' | 'at'> & { status: 'attempting' },
): LedgerRow {
  return store.appendLedger(row);
}

export function finalizeAttempt(
  store: Store,
  attemptId: string,
  outcome: ReserveOutcome,
  fields: Record<string, unknown> = {},
): LedgerRow {
  return store.appendLedger({
    ...fields,
    status: outcome,
    attemptId,
  });
}

export function assertCanProceedAfterUncertain(): never {
  assertNoAutoRetryAfterUncertain('uncertain');
  throw new Error('unreachable');
}