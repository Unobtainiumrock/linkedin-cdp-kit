import type { CdpSession } from '../cdp/session.js';
import { actionSleep, focusForInput } from './cdp-util.js';

export type ScrapeSession = {
  cdp: CdpSession;
  evaluate: (expression: string, timeoutMs?: number) => Promise<unknown>;
};

export type ScrapeConnectionsOptions = {
  live?: boolean;
  session?: ScrapeSession;
  anchorCap?: number;
  wallClockCapMs?: number;
  bringToFrontEvery?: number;
  maxIterations?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type ScrapedConnection = {
  slug: string;
  name: string;
  headline: string;
  connected: string;
  profileUrl: string;
};

export type ScrapeConnectionsResult =
  | { status: 'dry_run'; cap: number }
  | { status: 'complete' | 'capped' | 'manual_review'; connections: ScrapedConnection[]; reason?: string };

export const CONNECTIONS_PAGE_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

const ANCHOR_COUNT_EXPR = `document.querySelectorAll('a[href*="/in/"]').length`;

export const CONNECTION_HARVEST_EXPR = `(() => {
  const seen = {}, out = [];
  document.querySelectorAll('a[href*="/in/"]').forEach(a => {
    const slug = (a.href.match(/\\/in\\/([^\\/?]+)/) || [])[1];
    if (!slug) return;
    const card = a.closest('li') || a.parentElement;
    const lines = ((card ? card.innerText : a.innerText) || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const nameRaw = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean)[0] || lines[0] || '';
    const name = nameRaw.replace(/\\s*\\u2022.*$/, '').trim();
    const connectedLine = lines.find(l => /^connected/i.test(l)) || '';
    const noise = /^(Connect|Message|Follow|View|Status is|LinkedIn Member|\\u00b7|connected)/i;
    const sub = lines.filter(l => l !== nameRaw && !noise.test(l) && l.length > 1)[0] || '';
    if (!seen[slug]) { seen[slug] = 1; out.push({ slug, name, headline: sub, connected: connectedLine, profileUrl: 'https://www.linkedin.com/in/' + slug + '/' }); }
  });
  return { count: out.length, people: out };
})()`;

const SHOW_MORE_EXPR = `(() => { const b = [...document.querySelectorAll('button')].find(b => /show more results/i.test(b.innerText||'')); if (b) { b.click(); return true; } return false; })()`;

export function connectionCardFromText(slug: string, anchorText: string, cardText: string): ScrapedConnection | null {
  const clean = slug.trim();
  if (!clean) return null;
  const lines = cardText.split('\n').map((s) => s.trim()).filter(Boolean);
  const nameRaw = anchorText.split('\n').map((s) => s.trim()).filter(Boolean)[0] || lines[0] || '';
  const name = nameRaw.replace(/\s*\u2022.*$/, '').trim();
  const connected = lines.find((l) => /^connected/i.test(l)) || '';
  const noise = /^(Connect|Message|Follow|View|Status is|LinkedIn Member|\u00b7|connected)/i;
  const headline = lines.filter((l) => l !== nameRaw && !noise.test(l) && l.length > 1)[0] || '';
  return {
    slug: clean,
    name,
    headline,
    connected,
    profileUrl: `https://www.linkedin.com/in/${clean}/`,
  };
}

function randInt(random: () => number, lo: number, hi: number): number {
  return Math.floor(lo + random() * (hi - lo + 1));
}

function asCards(value: unknown): ScrapedConnection[] {
  const people = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { people?: unknown }).people)
      ? (value as { people: unknown[] }).people
      : [];
  const out: ScrapedConnection[] = [];
  for (const row of people) {
    if (!row || typeof row !== 'object') continue;
    const card = row as Partial<ScrapedConnection>;
    if (typeof card.slug !== 'string' || !card.slug) continue;
    out.push({
      slug: card.slug,
      name: typeof card.name === 'string' ? card.name : '',
      headline: typeof card.headline === 'string' ? card.headline : '',
      connected: typeof card.connected === 'string' ? card.connected : '',
      profileUrl: typeof card.profileUrl === 'string' ? card.profileUrl : `https://www.linkedin.com/in/${card.slug}/`,
    });
  }
  return out;
}

export async function scrapeConnections(opts: ScrapeConnectionsOptions = {}): Promise<ScrapeConnectionsResult> {
  const cap = opts.anchorCap ?? 300;
  if (!opts.live) return { status: 'dry_run', cap };
  if (!opts.session) {
    return { status: 'manual_review', connections: [], reason: 'live_scrape_requires_cdp_session' };
  }

  const wall = opts.wallClockCapMs ?? 8 * 60 * 1000;
  const every = opts.bringToFrontEvery ?? 10;
  const maxIterations = opts.maxIterations ?? 400;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => actionSleep(ms));
  const now = opts.now ?? Date.now;
  const { cdp, evaluate } = opts.session;

  await cdp.send('Runtime.enable', {}, 5_000);
  await cdp.send('Page.enable', {}, 5_000);
  await focusForInput(cdp);
  await cdp.send('Page.navigate', { url: CONNECTIONS_PAGE_URL }, 15_000);
  await sleep(randInt(random, 3500, 5500));

  let lastCount = -1;
  let stable = 0;
  const startedAt = now();
  let sinceLongPause = 0;
  let longPauseAt = randInt(random, 5, 9);
  let stop: 'stable' | 'cap' | 'wall' | 'max_iterations' = 'max_iterations';

  for (let i = 0; i < maxIterations && stable < 5 && lastCount < cap; i++) {
    if (now() - startedAt >= wall) {
      stop = 'wall';
      break;
    }
    try {
      if (i % every === 0) await focusForInput(cdp);
      const x = randInt(random, 380, 620);
      const y = randInt(random, 560, 840);
      if (random() < 0.4) {
        await cdp.send(
          'Input.dispatchMouseEvent',
          { type: 'mouseMoved', x: randInt(random, 300, 900), y: randInt(random, 300, 900) },
          5_000,
        );
        await sleep(randInt(random, 150, 500));
      }
      await cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x, y, deltaX: 0, deltaY: randInt(random, 1200, 2800) },
        5_000,
      );
      await sleep(randInt(random, 1800, 4200));

      const clicked = await evaluate(SHOW_MORE_EXPR);
      if (clicked === true) await sleep(randInt(random, 1000, 2200));

      sinceLongPause++;
      if (sinceLongPause >= longPauseAt) {
        await sleep(randInt(random, 6000, 14000));
        sinceLongPause = 0;
        longPauseAt = randInt(random, 5, 9);
      }

      const n = Number(await evaluate(ANCHOR_COUNT_EXPR));
      const count = Number.isFinite(n) ? n : lastCount;
      if (count === lastCount) stable++;
      else {
        stable = 0;
        lastCount = count;
      }
      if (stable >= 5) stop = 'stable';
      if (lastCount >= cap) stop = 'cap';
    } catch {
      stable++;
      if (stable >= 5) stop = 'stable';
    }
  }

  let connections: ScrapedConnection[] = [];
  try {
    connections = asCards(await evaluate(CONNECTION_HARVEST_EXPR));
  } catch (err) {
    return {
      status: 'manual_review',
      connections: [],
      reason: err instanceof Error ? err.message : 'harvest_failed',
    };
  }

  if (stop === 'cap' || lastCount >= cap) return { status: 'capped', connections };
  if (stop === 'stable') return { status: 'complete', connections };
  if (stop === 'wall') return { status: 'manual_review', connections, reason: 'wall_clock' };
  return { status: 'manual_review', connections, reason: 'max_iterations' };
}
