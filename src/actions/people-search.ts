import type { ActionSession } from './types.js';
import { actionSleep, navigate } from './cdp-util.js';
import { verifyNameTokens } from './connectability-tokens.js';

export type PeopleSearchHit = {
  slug: string;
  name: string;
  headline: string;
  degree: string;
  profileUrl: string;
  /** Set when the anchor sits in a sidebar. Those cards cannot satisfy the name check. */
  sidebar?: boolean;
};

export type PeopleSearchOptions = {
  keywords: string;
  hint?: string;
  limit?: number;
  live?: boolean;
  session?: ActionSession;
};

export function buildVoyagerPeopleSearch(keywords: string, csrfToken: string, start = 0, count = 10): string {
  const q = encodeURIComponent(keywords.trim());
  const endpoint = `/voyager/api/search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-175&count=${count}&origin=GLOBAL_SEARCH_HEADER&q=people&query=(keywords:${q},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))))&start=${start}`;
  return `
    (async () => {
      try {
        const resp = await fetch("${endpoint}", {
          headers: {
            "csrf-token": "${csrfToken}",
            "accept": "application/vnd.linkedin.normalized+json+2.1",
            "x-restli-protocol-version": "2.0.0",
          },
          credentials: "include",
        });
        if (!resp.ok) return JSON.stringify({ error: resp.status, endpoint: "${endpoint}" });
        return await resp.text();
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    })()
  `;
}

export const PEOPLE_SEARCH_HARVEST_EXPR = `(() => {
  const seen = {}, out = [];
  document.querySelectorAll('a[href*="/in/"]').forEach(a => {
    const slug = (a.href.match(/\\/in\\/([^\\/?]+)/) || [])[1];
    if (!slug || seen[slug]) return;
    const card = a.closest('li') || a.parentElement;
    const lines = ((card ? card.innerText : a.innerText) || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const nameRaw = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)[0] || lines[0] || '';
    const name = nameRaw.replace(/\\s*•.*$/, '').replace(/\\s*\\b(1st|2nd|3rd|3rd\\+)\\b.*$/i, '').trim();
    const noise = /^(\\d?(st|nd|rd|th)|•|Connect|Message|Follow|View|Status is|LinkedIn Member|·|\\d+ (mutual|shared))/i;
    const sub = lines.filter(l => l !== nameRaw && !noise.test(l) && l.length > 1)
      .find(l => !/^View .*profile$/i.test(l)) || '';
    const deg = (lines.find(l => /(1st|2nd|3rd\\+?)/.test(l)) || '').match(/(1st|2nd|3rd\\+?)/);
    const sidebar = !!(a.closest && a.closest('aside, [role="complementary"], .scaffold-layout__aside'));
    seen[slug] = 1;
    out.push({ slug, name, headline: sub, degree: deg ? deg[1] : '', profileUrl: 'https://www.linkedin.com/in/' + slug + '/', sidebar: sidebar });
  });
  return { count: out.length, people: out };
})()`;

export function pickBestPeopleMatch(
  hits: PeopleSearchHit[],
  opts: { expectedName?: string; hint?: string },
): PeopleSearchHit | null {
  const eligible = hits.filter((h) => h.sidebar !== true);
  const named = opts.expectedName
    ? eligible.filter((h) => verifyNameTokens(opts.expectedName ?? '', h.name))
    : eligible;
  if (opts.expectedName && named.length === 0) return null;
  if (opts.hint) {
    let re: RegExp;
    try {
      re = new RegExp(opts.hint, 'i');
    } catch {
      return null;
    }
    return named.find((h) => re.test(h.headline)) ?? null;
  }
  return named[0] ?? null;
}

function hitsFromVoyager(raw: unknown): PeopleSearchHit[] {
  if (typeof raw !== 'string') return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const included = Array.isArray((data as { included?: unknown }).included)
    ? ((data as { included: unknown[] }).included)
    : [];
  const out: PeopleSearchHit[] = [];
  for (const row of included) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (r['$type'] !== 'com.linkedin.voyager.dash.search.EntityResultViewModel') continue;
    const nav = r.navigationContext as { actionTarget?: string } | undefined;
    const url = nav?.actionTarget ?? '';
    const slugMatch = url.match(/\/in\/([^/?]+)/);
    const slug = slugMatch?.[1];
    if (!slug) continue;
    const title = typeof r.title === 'object' && r.title && 'text' in (r.title as object)
      ? String((r.title as { text?: string }).text ?? '')
      : '';
    const primary = typeof r.primarySubtitle === 'object' && r.primarySubtitle
      ? String((r.primarySubtitle as { text?: string }).text ?? '')
      : '';
    out.push({
      slug,
      name: title,
      headline: primary,
      degree: '',
      profileUrl: `https://www.linkedin.com/in/${slug}/`,
    });
  }
  return out;
}

function hitsFromDom(value: unknown): PeopleSearchHit[] {
  if (!value || typeof value !== 'object') return [];
  const people = (value as { people?: unknown[] }).people;
  if (!Array.isArray(people)) return [];
  const hits: PeopleSearchHit[] = [];
  for (const person of people) {
    if (!person || typeof person !== 'object') continue;
    const row = person as Partial<PeopleSearchHit & { sub?: string }>;
    if (typeof row.slug !== 'string') continue;
    const hit: PeopleSearchHit = {
      slug: row.slug,
      name: typeof row.name === 'string' ? row.name : '',
      headline: typeof row.headline === 'string' ? row.headline : typeof row.sub === 'string' ? row.sub : '',
      degree: typeof row.degree === 'string' ? row.degree : '',
      profileUrl: typeof row.profileUrl === 'string' ? row.profileUrl : `https://www.linkedin.com/in/${row.slug}/`,
    };
    if (row.sidebar === true) hit.sidebar = true;
    hits.push(hit);
  }
  return hits;
}

export type PeopleSearchResult =
  | { status: 'dry_run'; keywords: string }
  | {
      status: 'ok' | 'empty';
      keywords: string;
      hits: PeopleSearchHit[];
      best: PeopleSearchHit | null;
      source: 'voyager' | 'dom';
    };

export async function searchPeople(opts: PeopleSearchOptions): Promise<PeopleSearchResult> {
  const keywords = opts.keywords.trim();
  if (!keywords) throw new TypeError('keywords required');
  if (!opts.live) return { status: 'dry_run', keywords };
  const session = opts.session;
  if (!session) throw new Error('session required for live people search');

  const voyagerExpr = buildVoyagerPeopleSearch(keywords, session.csrfToken, 0, opts.limit ?? 10);
  const voyagerRaw = await session.evaluate(voyagerExpr);
  let hits = hitsFromVoyager(voyagerRaw);
  let source: 'voyager' | 'dom' = 'voyager';

  if (hits.length === 0) {
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;
    await navigate(session.cdp, url);
    await actionSleep(500);
    const domRaw = await session.evaluate(PEOPLE_SEARCH_HARVEST_EXPR);
    hits = hitsFromDom(domRaw);
    source = 'dom';
  }

  const best = pickBestPeopleMatch(hits, { expectedName: keywords, hint: opts.hint });
  return {
    status: hits.length > 0 ? 'ok' : 'empty',
    keywords,
    hits: hits.slice(0, opts.limit ?? 25),
    best,
    source,
  };
}