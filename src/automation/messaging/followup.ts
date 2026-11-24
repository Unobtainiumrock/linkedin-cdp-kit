import type { Store } from '../core/store.js';

export type FollowUpConfig = {
  daysAfterSend: number;
  maxNudgesPerThread: number;
};

export function shouldCreateNudge(
  store: Store,
  conversationUrn: string,
  sentAtIso: string,
  cfg: FollowUpConfig,
  nowMs = Date.now(),
): boolean {
  const sentAt = Date.parse(sentAtIso);
  if (!Number.isFinite(sentAt)) return false;
  if (nowMs - sentAt < cfg.daysAfterSend * 86_400_000) return false;
  const nudges = store.readLedger().filter((r) => r.conversationUrn === conversationUrn && r.status === 'nudge_draft');
  return nudges.length < cfg.maxNudgesPerThread;
}