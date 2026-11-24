import { createHash } from 'node:crypto';
import type { Store } from '../core/store.js';
import { evaluateGates, enterReviewHold, type GateConfig } from '../core/gates.js';
import { reserveBeforeClick, finalizeAttempt } from '../core/reserve.js';
import { beginRunReport } from '../core/report.js';
import { filterCommentContent, type ContentFilterResult } from './content-filter.js';
import { commentDraftId } from './draft-id.js';
import { jitteredDelay } from '../../pacing.js';
import type { NotifyHook } from '../core/types.js';
import type { ParsedPost } from '../../parse/profile.js';

export type CommentTarget = { slug: string; profileUrn?: string };

export type DraftHook = (post: ParsedPost, ctx: { slug: string }) =>
  | Promise<{ text: string } | { skip: true; reason: string }>
  | { text: string }
  | { skip: true; reason: string };

export type PostHistorySource = (slug: string) => Promise<ParsedPost[]>;

export type ApprovalPolicy = 'manual' | 'auto';

export type CommentAutomationConfig = {
  dryRun: boolean;
  freshnessHours: number;
  approvalPolicy: ApprovalPolicy;
  circuitBreakerThreshold: number;
  maxPerDay: number;
  minGapMs: number;
  gateConfig?: GateConfig;
};

export type PendingProposal = {
  id: string;
  slug: string;
  activityId: string;
  text: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'posted' | 'held';
};

export function activityCreatedMs(activityId: string): number {
  try {
    const id = BigInt(activityId);
    return Number(id >> 22n);
  } catch {
    return 0;
  }
}

export function isPostFresh(post: ParsedPost, freshnessHours: number, nowMs = Date.now()): boolean {
  if (!post.activityId) return false;
  const created = activityCreatedMs(post.activityId);
  return created > 0 && nowMs - created <= freshnessHours * 3_600_000;
}

export function newestOwnPost(posts: ParsedPost[], ownName?: string | null): ParsedPost | null {
  for (const p of posts) {
    if (!ownName || !p.author || p.author.toLowerCase().includes(ownName.split(' ')[0]?.toLowerCase() ?? '')) {
      return p;
    }
  }
  return posts[0] ?? null;
}

export async function captureAndDraft(
  store: Store,
  targets: CommentTarget[],
  loadPosts: PostHistorySource,
  draft: DraftHook,
  cfg: CommentAutomationConfig,
): Promise<PendingProposal[]> {
  const out: PendingProposal[] = [];
  const ledger = store.latestLedgerByField('activityId');

  for (const target of targets) {
    const posts = await loadPosts(target.slug);
    const post = newestOwnPost(posts);
    if (!post?.activityId || !post.text) continue;
    if (!isPostFresh(post, cfg.freshnessHours)) continue;
    if (ledger.has(post.activityId)) continue;

    const draftResult = await draft(post, { slug: target.slug });
    if ('skip' in draftResult && draftResult.skip) continue;

    const text = 'text' in draftResult ? draftResult.text : '';
    const filter: ContentFilterResult = filterCommentContent(text, post.text);
    if (!filter.ok) continue;

    const id = commentDraftId({ targetSlug: target.slug, text, activityId: post.activityId });
    const proposal: PendingProposal = {
      id,
      slug: target.slug,
      activityId: post.activityId,
      text,
      createdAt: new Date().toISOString(),
      status: cfg.approvalPolicy === 'auto' ? 'approved' : 'pending',
    };
    store.appendLedger({
      status: proposal.status,
      activityId: post.activityId,
      slug: target.slug,
      draftId: id,
      textHash: createHash('sha256').update(text.trim()).digest('hex'),
    });
    out.push(proposal);
  }
  if (store.readPending && store.writePending) {
    const existing = store.readPending();
    store.writePending([...existing, ...out]);
  }
  return out;
}

export type CommentExecutor = (args: {
  slug: string;
  postUrl: string;
  text: string;
  live: boolean;
}) => Promise<{ status: string }>;

export async function runCommentExecutor(
  store: Store,
  proposals: PendingProposal[],
  cfg: CommentAutomationConfig & { minGapMs: number; maxGapMs: number },
  executor: CommentExecutor,
  notify?: NotifyHook,
): Promise<unknown> {
  const { report, finish } = beginRunReport('comments', cfg.dryRun);
  let uncertainStreak = 0;

  if (!store.acquireLock()) return finish({ error: 'lock', held: true });

  try {
    for (const p of proposals.filter((x) => x.status === 'approved')) {
      const gate = evaluateGates(store, cfg.gateConfig ?? {});
      if (!gate.ok) {
        report.gateBlocks.push(gate.code);
        break;
      }

      if (uncertainStreak >= cfg.circuitBreakerThreshold) {
        enterReviewHold(store, 'comment_circuit_breaker');
        report.held = true;
        break;
      }

      if (cfg.dryRun) {
        report.actions.push({ draftId: p.id, status: 'dry_run' });
        continue;
      }

      const attempt = reserveBeforeClick(store, { status: 'attempting', draftId: p.id, slug: p.slug });
      const result = await executor({
        slug: p.slug,
        postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${p.activityId}/`,
        text: p.text,
        live: true,
      });

      if (result.status === 'posted') {
        uncertainStreak = 0;
        finalizeAttempt(store, attempt.id, 'posted', { draftId: p.id });
        await notify?.({ type: 'posted', detail: { draftId: p.id } });
      } else if (result.status === 'manual_review' || result.status === 'uncertain') {
        uncertainStreak++;
        finalizeAttempt(store, attempt.id, 'uncertain', { draftId: p.id });
        if (uncertainStreak >= cfg.circuitBreakerThreshold) {
          enterReviewHold(store, 'comment_uncertain_streak');
          report.held = true;
        }
      } else {
        finalizeAttempt(store, attempt.id, result.status, { draftId: p.id });
      }

      report.actions.push({ draftId: p.id, status: result.status });
      await jitteredDelay(cfg.minGapMs, cfg.maxGapMs);
    }
    return finish({ actions: report.actions, gateBlocks: report.gateBlocks, held: report.held });
  } finally {
    store.releaseLock();
  }
}

export function approveProposal(store: Store, draftId: string, exactText: string): boolean {
  const expectedId = store.readLedger().find((r) => r.draftId === draftId && r.status === 'pending');
  const hash = createHash('sha256').update(exactText.trim()).digest('hex');
  const recomputed = expectedId
    ? commentDraftId({
        targetSlug: String(expectedId.slug),
        text: exactText,
        activityId: String(expectedId.activityId),
      })
    : null;
  if (recomputed !== draftId) {
    store.appendLedger({ status: 'rejected', draftId, reason: 'text_edit_requires_new_id', textHash: hash });
    return false;
  }
  store.appendLedger({ status: 'approved', draftId, textHash: hash });
  return true;
}