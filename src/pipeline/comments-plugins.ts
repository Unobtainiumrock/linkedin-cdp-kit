import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineStore } from './persist.js';
import { listContacts, type ContactRecord } from './contacts.js';
import type { PendingProposal } from '../automation/comments/pipeline.js';
import { readPendingProposals, writePendingProposals } from '../automation/core/pending.js';

export type ReferenceBundle = {
  voice: string;
  rules: string;
  product: string;
  examples: string[];
};

export function loadReferenceBundle(dir: string): ReferenceBundle {
  const read = (name: string): string => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  const examplesDir = join(dir, 'examples');
  const examples: string[] = existsSync(examplesDir)
    ? readdirSync(examplesDir)
        .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
        .map((f) => readFileSync(join(examplesDir, f), 'utf8'))
    : [];
  return {
    voice: read('voice.md'),
    rules: read('rules.md'),
    product: read('product.md'),
    examples,
  };
}

export type LintFinding = { code: string; message: string; severity: 'error' | 'warn' };

export interface StyleLinter {
  lint(text: string, ctx: { reference: ReferenceBundle }): LintFinding[];
}

export interface DraftValidator {
  validate(text: string): LintFinding[];
}

export type DraftHook = (
  post: { url: string; author?: string; text?: string },
  ctx: {
    reference: ReferenceBundle;
    previousDraft?: string;
    lintFindings?: LintFinding[];
  },
) => string | Promise<string>;

export async function draftWithReviseOnce(
  draft: DraftHook,
  post: { url: string; author?: string; text?: string },
  reference: ReferenceBundle,
  linters: StyleLinter[],
): Promise<{ text: string; findings: LintFinding[] }> {
  let text = await draft(post, { reference });
  const findings = linters.flatMap((l) => l.lint(text, { reference }));
  const errors = findings.filter((f) => f.severity === 'error');
  if (errors.length === 0) return { text, findings };
  text = await draft(post, { reference, previousDraft: text, lintFindings: errors });
  const findings2 = linters.flatMap((l) => l.lint(text, { reference }));
  return { text, findings: [...findings, ...findings2] };
}

export type CommentTarget = { slug: string; name: string; postUrl?: string; lastCommentAt?: string };

export type TargetRotationConfig = {
  authorCooldownDays: number;
};

export const DEFAULT_TARGET_ROTATION: TargetRotationConfig = { authorCooldownDays: 14 };

export class TargetRotationSelector {
  constructor(private readonly config: TargetRotationConfig = DEFAULT_TARGET_ROTATION) {}

  select(contacts: ContactRecord[], recentPosters: CommentTarget[], now = Date.now()): CommentTarget[] {
    const eligible = contacts.filter((c) => ['qualified', 'connected'].includes(c.state) && !c.optOut);
    const cooldownMs = this.config.authorCooldownDays * 86_400_000;
    const bySlug = new Map(recentPosters.map((p) => [p.slug, p]));
    const scored: Array<{ target: CommentTarget; score: number }> = [];
    for (const c of eligible) {
      const recent = bySlug.get(c.slug);
      const last = recent?.lastCommentAt ? Date.parse(recent.lastCommentAt) : 0;
      const cooled = !last || now - last >= cooldownMs;
      if (!cooled) continue;
      const activityBoost = recent?.postUrl ? 1 : 0;
      const neverChecked = last ? 0 : 2;
      scored.push({
        target: { slug: c.slug, name: c.name, postUrl: recent?.postUrl, lastCommentAt: recent?.lastCommentAt },
        score: activityBoost + neverChecked,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.target);
  }
}

export interface ApprovalChannel {
  readonly id: string;
  listPending(store: PipelineStore): PendingProposal[];
  enqueue(store: PipelineStore, proposal: PendingProposal): void;
  approve(store: PipelineStore, id: string, text: string): boolean;
  reject(store: PipelineStore, id: string): void;
  mark(store: PipelineStore, id: string, status: PendingProposal['status']): boolean;
}

export class LocalPendingQueueApprovalChannel implements ApprovalChannel {
  readonly id = 'local_pending_json';

  listPending(store: PipelineStore): PendingProposal[] {
    return store.readPending?.() ?? readPendingProposals(store.rootDir);
  }

  enqueue(store: PipelineStore, proposal: PendingProposal): void {
    const rows = this.listPending(store);
    rows.push(proposal);
    if (store.writePending) store.writePending(rows);
    else writePendingProposals(store.rootDir, rows);
  }

  approve(store: PipelineStore, id: string, text: string): boolean {
    const rows = this.listPending(store);
    const idx = rows.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    rows[idx] = { ...rows[idx]!, status: 'approved', text };
    if (store.writePending) store.writePending(rows);
    else writePendingProposals(store.rootDir, rows);
    return true;
  }

  reject(store: PipelineStore, id: string): void {
    const next = rowsAfterReject(this.listPending(store), id);
    if (store.writePending) store.writePending(next);
    else writePendingProposals(store.rootDir, next);
  }

  mark(store: PipelineStore, id: string, status: PendingProposal['status']): boolean {
    const rows = this.listPending(store);
    const idx = rows.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    const current = rows[idx];
    if (!current) return false;
    rows[idx] = { ...current, status };
    if (store.writePending) store.writePending(rows);
    else writePendingProposals(store.rootDir, rows);
    return true;
  }
}

function rowsAfterReject(rows: PendingProposal[], id: string): PendingProposal[] {
  return rows.filter((p) => p.id !== id);
}

export function builtinMaxLengthLinter(maxLen: number): StyleLinter {
  return {
    lint(text) {
      if (text.length > maxLen) return [{ code: 'too_long', message: `>${maxLen} chars`, severity: 'error' }];
      return [];
    },
  };
}

export function loadTargetsFromLedger(store: PipelineStore): ContactRecord[] {
  return listContacts(store);
}