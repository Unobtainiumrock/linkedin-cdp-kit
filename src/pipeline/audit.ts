import type { PipelineStore } from './persist.js';
import { readContactLedger, writeContactLedger, type ContactRecord } from './contacts.js';
import { normalizeDiscoverySlug } from './discovery.js';

export type UnavailableAuditRow = {
  slug: string;
  kind: 'confirmed_404' | 'renamed_candidate' | 'unknown';
  detail: string;
  suggestedSlug?: string;
};

export type UnavailableAuditReport = {
  scanned: number;
  prune: UnavailableAuditRow[];
  repair: UnavailableAuditRow[];
};

export function auditUnavailable(
  records: ContactRecord[],
  probes: Record<string, { status: number; redirectSlug?: string }>,
): UnavailableAuditReport {
  const prune: UnavailableAuditRow[] = [];
  const repair: UnavailableAuditRow[] = [];
  for (const rec of records) {
    const probe = probes[rec.slug];
    if (!probe) continue;
    if (probe.status === 404) {
      prune.push({ slug: rec.slug, kind: 'confirmed_404', detail: 'profile_not_found' });
    } else if (probe.redirectSlug && probe.redirectSlug !== rec.slug) {
      repair.push({
        slug: rec.slug,
        kind: 'renamed_candidate',
        detail: 'redirect_slug',
        suggestedSlug: normalizeDiscoverySlug(probe.redirectSlug),
      });
    }
  }
  return { scanned: records.length, prune, repair };
}

export function applyUnavailableAudit(store: PipelineStore, report: UnavailableAuditReport): { pruned: number; repaired: number } {
  let ledger = readContactLedger(store);
  let pruned = 0;
  let repaired = 0;
  const pruneSlugs = new Set(report.prune.map((p) => p.slug));
  ledger = ledger.filter((r) => {
    if (pruneSlugs.has(r.slug)) {
      pruned += 1;
      return false;
    }
    return true;
  });
  for (const row of report.repair) {
    const idx = ledger.findIndex((r) => r.slug === row.slug);
    if (idx < 0 || !row.suggestedSlug) continue;
    ledger[idx] = { ...ledger[idx]!, slug: row.suggestedSlug, updatedAt: new Date().toISOString() };
    repaired += 1;
  }
  writeContactLedger(store, ledger);
  return { pruned, repaired };
}