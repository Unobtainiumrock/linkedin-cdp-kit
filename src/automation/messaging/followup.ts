import { randomBytes } from 'node:crypto';
import type { Store } from '../core/store.js';
import { readDrafts, writeDrafts, type MessageDraft } from './queue.js';

export type FollowUpConfig = {
  daysAfterSend: number;
  maxNudgesPerThread: number;
  nudgeText?: (conversationUrn: string) => string;
};

export const DEFAULT_FOLLOWUP_CONFIG: FollowUpConfig = {
  daysAfterSend: 4,
  maxNudgesPerThread: 2,
  nudgeText: () => 'Following up in case my earlier note got buried. Happy to share more detail if useful.',
};

export type ThreadFollowUpInput = {
  conversationUrn: string;
  ourLastSendAt: string;
  hasInboundReplyAfterSend: boolean;
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

export function createNudgeDrafts(
  rootDir: string,
  threads: ThreadFollowUpInput[],
  cfg: FollowUpConfig = DEFAULT_FOLLOWUP_CONFIG,
  nowMs = Date.now(),
): MessageDraft[] {
  const drafts = readDrafts(rootDir);
  const created: MessageDraft[] = [];
  for (const thread of threads) {
    if (thread.hasInboundReplyAfterSend) continue;
    const existing = drafts.filter(
      (d) => d.conversationUrn === thread.conversationUrn && d.status !== 'rejected' && d.text.startsWith('nudge:'),
    );
    if (existing.length >= cfg.maxNudgesPerThread) continue;
    const sentAt = Date.parse(thread.ourLastSendAt);
    if (!Number.isFinite(sentAt) || nowMs - sentAt < cfg.daysAfterSend * 86_400_000) continue;
    const id = `nudge-${randomBytes(8).toString('hex')}`;
    const text = cfg.nudgeText?.(thread.conversationUrn) ?? DEFAULT_FOLLOWUP_CONFIG.nudgeText!(thread.conversationUrn);
    const draft: MessageDraft = {
      id,
      conversationUrn: thread.conversationUrn,
      inboundFp: `nudge:${thread.ourLastSendAt}`,
      text: `nudge:${text}`,
      status: 'pending',
      createdAt: new Date(nowMs).toISOString(),
    };
    drafts.push(draft);
    created.push(draft);
  }
  if (created.length > 0) writeDrafts(rootDir, drafts);
  return created;
}