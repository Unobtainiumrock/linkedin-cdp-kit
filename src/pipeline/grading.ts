import type { PipelineStore } from './persist.js';
import type { AudienceProfile } from './strategy.js';
import { normalizeDiscoverySlug } from './discovery.js';
import type { InviteQueueEntry } from './discovery.js';

export type GradeDecision = 'qualify' | 'reject' | 'needs_research';

export type GradeResult = {
  decision: GradeDecision;
  tier?: string;
  score?: number;
  category?: string;
  evidenceQuote?: string;
  gaps?: string[];
};

export interface Grader {
  grade(input: { slug: string; name: string; profileText?: string }, ctx: { strategy?: AudienceProfile }): GradeResult | Promise<GradeResult>;
}

export type Qualifier = Grader;

const RESEARCH_FILE = 'research-queue.json';

export type ResearchQueueEntry = {
  slug: string;
  name: string;
  gaps: string[];
  queuedAt: string;
  lastVerifyAt?: string;
  verifyFailures?: number;
  nextVerifyAt?: string;
  profileCapturedAt?: string;
  stale?: boolean;
};

export function readResearchQueue(store: PipelineStore): ResearchQueueEntry[] {
  return store.readJson<ResearchQueueEntry[]>(RESEARCH_FILE, []);
}

export function writeResearchQueue(store: PipelineStore, rows: ResearchQueueEntry[]): void {
  store.writeJson(RESEARCH_FILE, rows);
}

export function applyGradeToQueue(
  store: PipelineStore,
  grader: Grader,
  strategy?: AudienceProfile,
): { qualified: InviteQueueEntry[]; rejected: number; research: number } {
  const queue = store.readJson<InviteQueueEntry[]>('invite-queue.json', []);
  const research = readResearchQueue(store);
  const qualified: InviteQueueEntry[] = [];
  let rejected = 0;
  let researchCount = 0;
  const remaining: InviteQueueEntry[] = [];

  for (const entry of queue) {
    const grade = grader.grade({ slug: entry.slug, name: entry.name }, { strategy });
    const resolved = grade instanceof Promise ? undefined : grade;
    if (!resolved) {
      remaining.push(entry);
      continue;
    }
    if (resolved.decision === 'qualify') {
      qualified.push({
        ...entry,
        tier: resolved.tier,
        score: resolved.score ?? entry.score,
      });
    } else if (resolved.decision === 'needs_research') {
      researchCount += 1;
      research.push({
        slug: normalizeDiscoverySlug(entry.slug),
        name: entry.name,
        gaps: resolved.gaps ?? [],
        queuedAt: new Date().toISOString(),
      });
    } else {
      rejected += 1;
    }
  }

  writeResearchQueue(store, research);
  store.writeJson('invite-queue.json', remaining);
  const ordered = orderQualifiedQueue(qualified);
  store.writeJson('invite-qualified.json', ordered);
  return { qualified: ordered, rejected, research: researchCount };
}

export async function applyGradeToQueueAsync(
  store: PipelineStore,
  grader: Grader,
  strategy?: AudienceProfile,
): Promise<{ qualified: InviteQueueEntry[]; rejected: number; research: number }> {
  const queue = store.readJson<InviteQueueEntry[]>('invite-queue.json', []);
  const research = readResearchQueue(store);
  const qualified: InviteQueueEntry[] = [];
  let rejected = 0;
  let researchCount = 0;
  const remaining: InviteQueueEntry[] = [];

  for (const entry of queue) {
    const grade = await grader.grade({ slug: entry.slug, name: entry.name }, { strategy });
    if (grade.decision === 'qualify') {
      qualified.push({ ...entry, tier: grade.tier, score: grade.score ?? entry.score });
    } else if (grade.decision === 'needs_research') {
      researchCount += 1;
      research.push({
        slug: normalizeDiscoverySlug(entry.slug),
        name: entry.name,
        gaps: grade.gaps ?? [],
        queuedAt: new Date().toISOString(),
      });
    } else {
      rejected += 1;
    }
  }

  writeResearchQueue(store, research);
  store.writeJson('invite-queue.json', remaining);
  const ordered = orderQualifiedQueue(qualified);
  store.writeJson('invite-qualified.json', ordered);
  return { qualified: ordered, rejected, research: researchCount };
}

export function orderQualifiedQueue(entries: InviteQueueEntry[]): InviteQueueEntry[] {
  return [...entries].sort((a, b) => {
    const sa = a.score ?? 0;
    const sb = b.score ?? 0;
    if (sb !== sa) return sb - sa;
    const ta = a.tier ?? 'z';
    const tb = b.tier ?? 'z';
    if (ta !== tb) return ta.localeCompare(tb);
    return a.insertedAt.localeCompare(b.insertedAt);
  });
}

export function defaultScoreGrader(minScore: number): Grader {
  return {
    grade(input) {
      const score = input.name.length % 10 / 10;
      if (score < minScore) return { decision: 'reject', score };
      if (!input.profileText) return { decision: 'needs_research', score, gaps: ['profile_text'] };
      return { decision: 'qualify', score, tier: score > 0.7 ? 'tier1' : 'tier2' };
    },
  };
}