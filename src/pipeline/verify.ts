import type { LinkedInActions } from '../actions/types.js';
import type { PipelineStore } from './persist.js';
import { readResearchQueue, writeResearchQueue, type ResearchQueueEntry } from './grading.js';
import type { Grader } from './grading.js';
import type { InviteQueueEntry } from './discovery.js';
import { orderQualifiedQueue } from './grading.js';

export type VerifyBackoffHours = [number, number, number, number];

export const DEFAULT_VERIFY_BACKOFF_HOURS: VerifyBackoffHours = [24, 72, 168, 720];

export type ProfileVerifierConfig = {
  backoffHours: VerifyBackoffHours;
  staleAfterDays: number;
};

export const DEFAULT_PROFILE_VERIFIER_CONFIG: ProfileVerifierConfig = {
  backoffHours: DEFAULT_VERIFY_BACKOFF_HOURS,
  staleAfterDays: 30,
};

export type VerifyRunReport = {
  attempted: number;
  enriched: number;
  regraded: number;
  skippedBackoff: number;
  skippedStaleOnly: number;
};

function hoursToMs(h: number): number {
  return h * 3_600_000;
}

function pickBackoff(failures: number, hours: VerifyBackoffHours): number {
  const idx = Math.min(Math.max(failures, 0), hours.length - 1);
  return hours[idx]!;
}

export function isVerifyDue(entry: ResearchQueueEntry, now = Date.now()): boolean {
  if (!entry.nextVerifyAt) return true;
  return Date.parse(entry.nextVerifyAt) <= now;
}

export function flagStaleCaptures(entries: ResearchQueueEntry[], staleAfterDays: number, now = Date.now()): ResearchQueueEntry[] {
  const maxAge = staleAfterDays * 86_400_000;
  return entries.map((e) => {
    if (!e.profileCapturedAt) return e;
    const age = now - Date.parse(e.profileCapturedAt);
    return { ...e, stale: age > maxAge };
  });
}

export async function runVerify(
  store: PipelineStore,
  actions: Pick<LinkedInActions, 'fetchProfile'> | undefined,
  grader: Grader,
  opts: { config?: ProfileVerifierConfig; live?: boolean } = {},
): Promise<VerifyRunReport> {
  const config = opts.config ?? DEFAULT_PROFILE_VERIFIER_CONFIG;
  let queue = readResearchQueue(store);
  queue = flagStaleCaptures(queue, config.staleAfterDays);
  const report: VerifyRunReport = {
    attempted: 0,
    enriched: 0,
    regraded: 0,
    skippedBackoff: 0,
    skippedStaleOnly: 0,
  };

  const enrichedSlugs: string[] = [];

  for (let i = 0; i < queue.length; i += 1) {
    const entry = queue[i]!;
    if (!isVerifyDue(entry)) {
      report.skippedBackoff += 1;
      continue;
    }
    if (entry.stale && entry.profileCapturedAt) {
      report.skippedStaleOnly += 1;
    }
    if (!opts.live || !actions) continue;

    report.attempted += 1;
    try {
      const profile = await actions.fetchProfile(entry.slug);
      const about = JSON.stringify(profile).slice(0, 4_000);
      queue[i] = {
        ...entry,
        profileCapturedAt: new Date().toISOString(),
        lastVerifyAt: new Date().toISOString(),
        stale: false,
        gaps: [],
      };
      enrichedSlugs.push(entry.slug);
      report.enriched += 1;
      const grade = await grader.grade({ slug: entry.slug, name: entry.name, profileText: about }, {});
      if (grade.decision === 'qualify') {
        const qualified = store.readJson<InviteQueueEntry[]>('invite-qualified.json', []);
        qualified.push({
          slug: entry.slug,
          name: entry.name,
          sourceId: 'verify',
          tier: grade.tier,
          score: grade.score,
          insertedAt: new Date().toISOString(),
        });
        store.writeJson('invite-qualified.json', orderQualifiedQueue(qualified));
        queue = queue.filter((r) => r.slug !== entry.slug);
        report.regraded += 1;
      }
    } catch {
      const failures = (entry.verifyFailures ?? 0) + 1;
      const hrs = pickBackoff(failures, config.backoffHours);
      queue[i] = {
        ...entry,
        verifyFailures: failures,
        nextVerifyAt: new Date(Date.now() + hoursToMs(hrs)).toISOString(),
        lastVerifyAt: new Date().toISOString(),
      };
    }
  }

  writeResearchQueue(store, queue);
  void enrichedSlugs;
  return report;
}