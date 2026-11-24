import { readFileSync, existsSync } from 'node:fs';
import { toSlug } from '../parse/slug.js';
import type { PipelineStore } from './persist.js';
import type { AudienceProfile } from './strategy.js';
import type { ContactRecord } from './contacts.js';
import { readContactLedger } from './contacts.js';

export type DiscoveryCandidate = {
  slug: string;
  name: string;
  sourceId: string;
  meta?: Record<string, string>;
};

export type DiscoveryBatch = {
  candidates: DiscoveryCandidate[];
  nextCursor: string | null;
  exhausted: boolean;
};

export interface DiscoverySource {
  readonly id: string;
  fetchBatch(cursor: string | null, budget: number): Promise<DiscoveryBatch> | DiscoveryBatch;
}

type SourceFrontier = Record<string, { cursor: string | null; exhausted: boolean; updatedAt: string }>;

export type RefillConfig = {
  floor: number;
  batchBudget: number;
  perSourceMaxShare: number;
};

export const DEFAULT_REFILL_CONFIG: RefillConfig = {
  floor: 250,
  batchBudget: 100,
  perSourceMaxShare: 0.5,
};

export function normalizeDiscoverySlug(raw: string): string {
  const slug = toSlug(raw) ?? raw.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  return slug.toLowerCase();
}

export class JsonFileSource implements DiscoverySource {
  readonly id: string;
  private readonly rows: DiscoveryCandidate[];
  private offset = 0;

  constructor(id: string, filePath: string) {
    this.id = id;
    const data = JSON.parse(readFileSync(filePath, 'utf8')) as Array<{ slug: string; name: string; meta?: Record<string, string> }>;
    this.rows = data.map((r) => ({
      slug: normalizeDiscoverySlug(r.slug),
      name: r.name,
      sourceId: id,
      meta: r.meta,
    }));
  }

  fetchBatch(cursor: string | null, budget: number): DiscoveryBatch {
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const offset = Number.isFinite(start) ? start : 0;
    this.offset = offset;
    const slice = this.rows.slice(offset, offset + budget);
    const next = offset + slice.length;
    const exhausted = next >= this.rows.length;
    return {
      candidates: slice,
      nextCursor: exhausted ? null : String(next),
      exhausted,
    };
  }
}

export class CsvFileSource implements DiscoverySource {
  readonly id: string;
  private readonly rows: DiscoveryCandidate[];

  constructor(id: string, filePath: string) {
    this.id = id;
    if (!existsSync(filePath)) {
      this.rows = [];
      return;
    }
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const header = lines[0]?.split(',') ?? [];
    const slugIdx = header.indexOf('slug');
    const nameIdx = header.indexOf('name');
    this.rows = lines.slice(1).map((line) => {
      const cols = line.split(',');
      const slug = normalizeDiscoverySlug(cols[slugIdx] ?? cols[0] ?? '');
      const name = cols[nameIdx] ?? cols[1] ?? slug;
      return { slug, name, sourceId: id };
    });
  }

  fetchBatch(cursor: string | null, budget: number): DiscoveryBatch {
    const start = cursor ? Number.parseInt(cursor, 10) : 0;
    const slice = this.rows.slice(start, start + budget);
    const next = start + slice.length;
    return {
      candidates: slice,
      nextCursor: next >= this.rows.length ? null : String(next),
      exhausted: next >= this.rows.length,
    };
  }
}

const FRONTIERS_FILE = 'discovery-frontiers.json';
const QUEUE_FILE = 'invite-queue.json';

export type InviteQueueEntry = {
  slug: string;
  name: string;
  sourceId: string;
  tier?: string;
  score?: number;
  insertedAt: string;
};

export type RefillReport = {
  eligibleBefore: number;
  added: number;
  skippedDedup: number;
  skippedOptOut: number;
  bySource: Record<string, number>;
  eligibleAfter: number;
};

function readQueue(store: PipelineStore): InviteQueueEntry[] {
  return store.readJson<InviteQueueEntry[]>(QUEUE_FILE, []);
}

function readFrontiers(store: PipelineStore): SourceFrontier {
  return store.readJson<SourceFrontier>(FRONTIERS_FILE, {});
}

export function countEligibleQueue(store: PipelineStore): number {
  return readQueue(store).length;
}

function isDeduped(slug: string, ledger: ContactRecord[], queue: InviteQueueEntry[], historySlugs: Set<string>): boolean {
  if (historySlugs.has(slug)) return true;
  if (queue.some((q) => q.slug === slug)) return true;
  return ledger.some((c) => c.slug === slug && (c.optOut || ['invited', 'connected', 'commented', 'messaged'].includes(c.state)));
}

export async function runRefill(
  store: PipelineStore,
  sources: DiscoverySource[],
  opts: {
    config?: RefillConfig;
    strategy?: AudienceProfile;
    optOutSlugs?: Set<string>;
  } = {},
): Promise<RefillReport> {
  const config = opts.config ?? DEFAULT_REFILL_CONFIG;
  const queue = readQueue(store);
  const eligibleBefore = queue.length;
  if (eligibleBefore >= config.floor) {
    return {
      eligibleBefore,
      added: 0,
      skippedDedup: 0,
      skippedOptOut: 0,
      bySource: {},
      eligibleAfter: eligibleBefore,
    };
  }

  const need = config.floor - eligibleBefore;
  const budget = Math.min(need, config.batchBudget);
  const perSourceBudget = Math.max(1, Math.floor(budget * config.perSourceMaxShare));
  const frontiers = readFrontiers(store);
  const ledger = readContactLedger(store);
  const historySlugs = new Set(store.readLedger().map((r) => normalizeDiscoverySlug(String(r['slug'] ?? ''))));
  const optOut = opts.optOutSlugs ?? new Set(ledger.filter((c) => c.optOut).map((c) => c.slug));

  let added = 0;
  let skippedDedup = 0;
  let skippedOptOut = 0;
  const bySource: Record<string, number> = {};
  const nextQueue = [...queue];

  for (const source of sources) {
    if (added >= budget) break;
    const frontier = frontiers[source.id] ?? { cursor: null, exhausted: false, updatedAt: new Date().toISOString() };
    if (frontier.exhausted) continue;
    const batch = await Promise.resolve(source.fetchBatch(frontier.cursor, perSourceBudget));
    frontiers[source.id] = {
      cursor: batch.nextCursor,
      exhausted: batch.exhausted,
      updatedAt: new Date().toISOString(),
    };
    bySource[source.id] = 0;
    for (const c of batch.candidates) {
      const slug = normalizeDiscoverySlug(c.slug);
      if (optOut.has(slug)) {
        skippedOptOut += 1;
        continue;
      }
      if (isDeduped(slug, ledger, nextQueue, historySlugs)) {
        skippedDedup += 1;
        continue;
      }
      nextQueue.push({
        slug,
        name: c.name,
        sourceId: c.sourceId,
        insertedAt: new Date().toISOString(),
        score: opts.strategy ? 0.5 : undefined,
      });
      historySlugs.add(slug);
      added += 1;
      bySource[source.id] = (bySource[source.id] ?? 0) + 1;
      if (added >= budget) break;
    }
  }

  store.writeJson(FRONTIERS_FILE, frontiers);
  store.writeJson(QUEUE_FILE, nextQueue);
  void opts.strategy;

  return {
    eligibleBefore,
    added,
    skippedDedup,
    skippedOptOut,
    bySource,
    eligibleAfter: nextQueue.length,
  };
}