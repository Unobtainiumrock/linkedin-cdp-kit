import { createHash } from 'node:crypto';
import { jitteredDelay } from '../../pacing.js';
import type { Store } from '../core/store.js';
import { evaluateGates, enterCooldown, enterReviewHold, resumeFromReview, type GateConfig } from '../core/gates.js';
import { reserveBeforeClick, finalizeAttempt } from '../core/reserve.js';
import { beginRunReport } from '../core/report.js';
import type { NotifyHook } from '../core/types.js';
import type { InviteCandidate, InviteRunConfig, QualifyResult } from './types.js';
import type { ConnectionInviteResult } from '../../actions/invite.js';
import { isUnavailableBlocked, recordUnavailable } from './unavailable.js';
import type { LinkedInActions } from '../../actions/types.js';
import type { RunReport } from '../core/types.js';
import { syncInviteSent } from '../../pipeline/contacts.js';
import { asPipelineStore } from '../../pipeline/persist.js';

export type CandidateSource = () => Promise<InviteCandidate[]> | InviteCandidate[];

export type InviteAction = (candidate: InviteCandidate, live: boolean) => Promise<ConnectionInviteResult>;

export type InviteRunnerDeps = {
  store: Store;
  source: CandidateSource | InviteCandidate[];
  qualify?: (c: InviteCandidate) => QualifyResult;
  sendInvite: InviteAction;
  actions?: LinkedInActions;
  verifySentPage?: (recipientName: string) => Promise<boolean>;
  notify?: NotifyHook;
  gateConfig?: GateConfig;
  config: InviteRunConfig;
};

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

export function slugLedgerKey(slug: string): string {
  return createHash('sha256').update(normalizeSlug(slug)).digest('hex').slice(0, 16);
}

export async function runInvites(deps: InviteRunnerDeps): Promise<RunReport> {
  const { store, source, config } = deps;
  const { report, finish } = beginRunReport('invites', config.dryRun);
  const gateCfg: GateConfig = {
    ...deps.gateConfig,
    rollingWindowMs: config.rollingWindowMs,
    rollingMaxActions: config.rollingMaxInvites,
    runBudgetMs: config.runBudgetMs,
    runStartedAt: Date.now(),
  };

  if (!store.acquireLock()) {
    return finish({ error: 'could_not_acquire_lock', held: true });
  }

  try {
    const preGate = evaluateGates(store, gateCfg);
    if (!preGate.ok) {
      report.gateBlocks.push(preGate.code);
      return finish({ gateBlocks: report.gateBlocks, held: true });
    }

    const candidates =
      typeof source === 'function'
        ? await Promise.resolve((source as CandidateSource)())
        : await Promise.resolve(source as InviteCandidate[]);
    const ledger = store.latestLedgerByField('slug');
    let lastSent: string | null = null;

    for (const candidate of candidates) {
      const slug = normalizeSlug(candidate.slug);
      const gate = evaluateGates(store, { ...gateCfg, runStartedAt: Date.now() });
      if (!gate.ok) {
        report.gateBlocks.push(gate.code);
        break;
      }

      if (candidate.optOut) {
        report.actions.push({ slug, status: 'skipped', reason: 'opt_out' });
        continue;
      }

      if (isUnavailableBlocked(store, slug)) {
        report.actions.push({ slug, status: 'skipped', reason: 'unavailable_backoff' });
        continue;
      }

      const prev = ledger.get(slug);
      if (prev && ['sent', 'attempting', 'rejected_resend'].includes(String(prev.status))) {
        report.actions.push({ slug, status: 'skipped', reason: 'ledger_dedup' });
        continue;
      }

      const qual = deps.qualify?.(candidate) ?? { decision: 'qualify' as const };
      if (qual.decision !== 'qualify') {
        report.actions.push({ slug, status: 'skipped', reason: qual.decision, detail: 'reason' in qual ? qual.reason : '' });
        continue;
      }

      if (config.dryRun) {
        report.actions.push({ slug, status: 'dry_run', name: candidate.name });
        continue;
      }

      const attempt = reserveBeforeClick(store, {
        status: 'attempting',
        slug,
        name: candidate.name,
      });

      let result: ConnectionInviteResult;
      try {
        result = await deps.sendInvite(candidate, true);
      } catch (err) {
        finalizeAttempt(store, attempt.id, 'uncertain', { slug, error: err instanceof Error ? err.message : String(err) });
        enterReviewHold(store, 'invite threw');
        await deps.notify?.({ type: 'held', reason: 'invite threw' });
        report.held = true;
        break;
      }

      const status = mapInviteResult(result);
      finalizeAttempt(store, attempt.id, status, { slug, result });

      if (status === 'rejected_limit') {
        const until = new Date(Date.now() + config.cooldownDaysOnLimit * 86_400_000).toISOString();
        enterCooldown(store, until, 'FUSE_LIMIT_EXCEEDED');
        await deps.notify?.({ type: 'paused', reason: 'limit' });
        report.held = true;
        break;
      }
      if (status === 'uncertain' || status === 'recipient_name_mismatch') {
        enterReviewHold(store, status);
        await deps.notify?.({ type: 'held', reason: status });
        report.held = true;
        break;
      }
      if (status === 'unavailable') {
        recordUnavailable(store, slug, { backoffHours: config.unavailableBackoffHours });
      }

      if (status === 'security_warning') {
        enterReviewHold(store, 'security_warning');
        report.held = true;
        break;
      }

      if (status === 'sent') {
        lastSent = candidate.name;
        syncInviteSent(asPipelineStore(store), slug, candidate.name);
        await deps.notify?.({ type: 'posted', detail: { slug, module: 'invites' } });
      }

      report.actions.push({ slug, status, result });
      await jitteredDelay(config.minGapSec * 1000, config.maxGapSec * 1000);
    }

    if (!config.dryRun && lastSent) {
      const verify =
        deps.verifySentPage ??
        (async (name: string) => (deps.actions ? (await deps.actions.verifySentInvites(name)).ok : true));
      const ok = await verify(lastSent);
      report.actions.push({ verifySentPage: lastSent, ok });
      if (!ok) {
        enterReviewHold(store, 'sent_page_verification_failed');
        report.held = true;
      }
    }

    return finish({ actions: report.actions, gateBlocks: report.gateBlocks, held: report.held });
  } finally {
    store.releaseLock();
  }
}

function mapInviteResult(result: ConnectionInviteResult): string {
  if (result.status === 'dry_run') return 'dry_run';
  return result.status;
}

export function inviteStatus(store: Store): Record<string, unknown> {
  const state = store.readState();
  const unresolved = store.readLedger().filter((r) => r.status === 'attempting').length;
  return { state, unresolvedAttempts: unresolved };
}

export function resumeInvites(store: Store, reason: string): void {
  resumeFromReview(store, reason);
}