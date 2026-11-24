import { makePaginationToken } from './pagination.js';
import { buildFetchProfile, buildFetchProfileUpdates } from './builders.js';
import { parseProfile, parseProfileUpdates, type ParsedProfile, type ProfilePostsMeta } from '../parse/profile.js';
import { toSlug } from '../parse/slug.js';

export type VoyagerEvaluateSession = {
  csrfToken: string;
  evaluate: (expression: string, timeoutMs?: number) => Promise<unknown>;
};

function parseJsonish(raw: unknown, what: string): unknown {
  if (raw === null || raw === undefined) throw new Error(`Empty ${what} response`);
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Unparseable ${what} response`);
  }
}

export type PullProfilePostsResult = {
  posts: ReturnType<typeof parseProfileUpdates>['posts'];
  complete: boolean;
  truncated: boolean;
  error: string | null;
  pagesFetched: number;
};

export async function pullProfilePosts(
  session: VoyagerEvaluateSession,
  profileUrn: string,
  opts: { maxPages?: number; delayMs?: number; count?: number; log?: (msg: string) => void } = {},
): Promise<PullProfilePostsResult> {
  const { maxPages = 25, delayMs = 1200, count = 20, log = () => {} } = opts;
  const { evaluate, csrfToken } = session;

  const seen = new Map<string, ReturnType<typeof parseProfileUpdates>['posts'][number]>();
  let paginationToken: string | null = null;
  let start = 0;
  let complete = false;
  let truncated = false;
  let error: string | null = null;
  let pagesFetched = 0;
  const usedTokens = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    let raw: unknown;
    try {
      raw = await evaluate(buildFetchProfileUpdates(csrfToken, profileUrn, { start, paginationToken, count }));
    } catch (err) {
      error = `page ${page}: ${err instanceof Error ? err.message : String(err)}`;
      log(`  ${error}`);
      break;
    }
    pagesFetched++;

    const parsed = parseProfileUpdates(raw);
    if (parsed.apiError !== null && parsed.apiError !== undefined) {
      error = `page ${page}: API returned ${JSON.stringify(parsed.apiError)}`;
      log(`  ${error}`);
      break;
    }

    let fresh = 0;
    for (const post of parsed.posts) {
      const key = post.urn || `text:${post.text}`;
      if (seen.has(key)) continue;
      seen.set(key, post);
      fresh++;
    }
    log(`  page ${page}: +${fresh} new (${seen.size} total)`);

    if (parsed.posts.length === 0 || parsed.lastActivityId === null) {
      complete = true;
      break;
    }

    let nextToken: string;
    try {
      nextToken = makePaginationToken(parsed.lastActivityId);
    } catch (err) {
      error = `page ${page}: could not build next cursor (${err instanceof Error ? err.message : String(err)})`;
      log(`  ${error}`);
      break;
    }

    // A repeated cursor is not a natural end. A 429 is already an apiError.
    // An empty page is the path that sets complete.
    if (usedTokens.has(nextToken)) {
      error = `page ${page}: pagination cursor stalled`;
      log(`  ${error}`);
      break;
    }
    usedTokens.add(nextToken);

    paginationToken = nextToken;
    start += count;
    if (page === maxPages - 1) truncated = true;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  if (truncated) {
    log(`  WARNING: stopped at the ${maxPages}-page cap — history is INCOMPLETE.`);
  }

  return {
    posts: [...seen.values()],
    complete: complete && !truncated && !error,
    truncated,
    error,
    pagesFetched,
  };
}

export type PullProfileResult = ParsedProfile & {
  posts?: ReturnType<typeof parseProfileUpdates>['posts'];
  postsMeta?: ProfilePostsMeta;
};

export async function pullProfile(
  session: VoyagerEvaluateSession,
  publicIdentifierOrUrl: string,
  opts: { posts?: boolean; log?: (msg: string) => void; maxPages?: number; delayMs?: number; count?: number } = {},
): Promise<PullProfileResult> {
  const { posts = false, log = () => {}, ...rest } = opts;
  const { evaluate, csrfToken } = session;

  const slug = toSlug(publicIdentifierOrUrl) ?? publicIdentifierOrUrl;
  if (!slug || typeof slug !== 'string') {
    throw new Error(`Invalid public identifier: ${JSON.stringify(publicIdentifierOrUrl)}`);
  }

  log(`Fetching profile: ${slug}`);
  const raw = await evaluate(buildFetchProfile(csrfToken, slug));
  if (!raw) throw new Error(`No response for profile "${slug}"`);

  const data = parseJsonish(raw, `profile "${slug}"`) as { error?: unknown };
  if (data?.error !== undefined && data?.error !== null) {
    throw new Error(`Profile fetch failed for "${slug}": HTTP ${String(data.error)}`);
  }

  const profile = parseProfile(data, { expectPublicIdentifier: slug });
  if (!profile) {
    throw new Error(`No profile object for "${slug}"`);
  }

  if (!posts) return profile;

  if (!profile.profileUrn) {
    log('No profileUrn on the profile record — cannot walk post history.');
    return {
      ...profile,
      posts: [],
      postsMeta: { complete: false, truncated: false, error: 'no profileUrn on profile record', pagesFetched: 0 },
    };
  }

  log('Walking post history...');
  const { posts: history, ...meta } = await pullProfilePosts(session, profile.profileUrn, { log, ...rest });
  return { ...profile, posts: history, postsMeta: meta };
}