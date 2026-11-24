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
import { readContactLedger, type ContactRecord } from '../../pipeline/contacts.js';
import { asPipelineStore } from '../../pipeline/persist.js';
import {
  draftWithReviseOnce,
  LocalPendingQueueApprovalChannel,
  type ApprovalChannel,
  type CommentTarget as RotatedCommentTarget,
  type LintFinding,
  type ReferenceBundle,
  type StyleLinter,
  type TargetRotationSelector,
} from '../../pipeline/comments-plugins.js';

export type CommentTarget = { slug: string; profileUrn?: string };

export type DraftHookContext = {
  slug: string;
  reference?: ReferenceBundle;
  previousDraft?: string;
  lintFindings?: LintFinding[];
};

export type DraftHook = (post: ParsedPost, ctx: DraftHookContext) =>
  | Promise<{ text: string } | { skip: true; reason: string }>
  | { text: string }
  | { skip: true; reason: string };

export type CaptureAndDraftOptions = {
  referenceBundle?: ReferenceBundle;
  styleLinters?: StyleLinter[];
  targetSelector?: TargetRotationSelector;
  contacts?: ContactRecord[];
  recentPosters?: RotatedCommentTarget[];
  approvalChannel?: ApprovalChannel;
};

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

function selectCaptureTargets(store: Store, targets: CommentTarget[], opts: CaptureAndDraftOptions): CommentTarget[] {
  if (!opts.targetSelector) return targets;
  const contacts = opts.contacts ?? readContactLedger(store);
  const selected = opts.targetSelector.select(contacts, opts.recentPosters ?? []);
  if (targets.length === 0) return selected.map((row) => ({ slug: row.slug }));
  const allowed = new Set(selected.map((row) => row.slug));
  return targets.filter((target) => allowed.has(target.slug));
}

async function draftCommentText(
  draft: DraftHook,
  post: ParsedPost,
  slug: string,
  opts: CaptureAndDraftOptions,
): Promise<string | { skip: true; reason: string }> {
  const linters = opts.styleLinters ?? [];
  if (linters.length === 0) {
    const once = await draft(post, { slug });
    if ('skip' in once && once.skip) return once;
    return 'text' in once ? once.text : '';
  }
  const reference = opts.referenceBundle ?? { voice: '', rules: '', product: '', examples: [] };
  let skipped: { skip: true; reason: string } | null = null;
  const revised = await draftWithReviseOnce(
    async (_post, ctx) => {
      const result = await draft(post, {
        slug,
        reference: ctx.reference,
        previousDraft: ctx.previousDraft,
        lintFindings: ctx.lintFindings,
      });
      if ('skip' in result && result.skip) {
        skipped = result;
        return '';
      }
      return 'text' in result ? result.text : '';
    },
    {
      url: `https://www.linkedin.com/feed/update/urn:li:activity:${post.activityId ?? ''}/`,
      author: post.author ?? undefined,
      text: post.text,
    },
    reference,
    linters,
  );
  if (skipped) return skipped;
  const stillFlagged = linters.flatMap((linter) => linter.lint(revised.text, { reference })).some((f) => f.severity === 'error');
  if (stillFlagged) return { skip: true, reason: 'style_linter' };
  return revised.text;
}

export async function captureAndDraft(
  store: Store,
  targets: CommentTarget[],
  loadPosts: PostHistorySource,
  draft: DraftHook,
  cfg: CommentAutomationConfig,
  opts: CaptureAndDraftOptions = {},
): Promise<PendingProposal[]> {
  const out: PendingProposal[] = [];
  const ledger = store.latestLedgerByField('activityId');
  const channel = opts.approvalChannel ?? new LocalPendingQueueApprovalChannel();
  const pipelineStore = asPipelineStore(store);
  const work = selectCaptureTargets(store, targets, opts);

  for (const target of work) {
    const posts = await loadPosts(target.slug);
    const post = newestOwnPost(posts);
    if (!post?.activityId || !post.text) continue;
    if (!isPostFresh(post, cfg.freshnessHours)) continue;
    if (ledger.has(post.activityId)) continue;

    const drafted = await draftCommentText(draft, post, target.slug, opts);
    if (typeof drafted !== 'string') continue;
    const text = drafted.trim();
    if (!text) continue;
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
    channel.enqueue(pipelineStore, proposal);
    out.push(proposal);
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
  approvalChannel?: ApprovalChannel,
): Promise<unknown> {
  const { report, finish } = beginRunReport('comments', cfg.dryRun);
  let uncertainStreak = 0;
  const pipelineStore = asPipelineStore(store);
  const queued = approvalChannel
    ? approvalChannel.listPending(pipelineStore).filter((row) => row.status === 'approved')
    : proposals.filter((row) => row.status === 'approved');

  if (!store.acquireLock()) return finish({ error: 'lock', held: true });

  try {
    for (const p of queued) {
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
        approvalChannel?.mark(pipelineStore, p.id, 'posted');
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