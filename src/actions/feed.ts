import type { ActionSession } from './types.js';
import { actionSleep, bringToFront, focusForInput, navigate } from './cdp-util.js';

export type FeedPost = {
  activityUrn: string;
  activityId: string;
  author: string;
  text: string;
};

export type FeedReaction = 'LIKE' | 'CELEBRATE' | 'SUPPORT' | 'LOVE' | 'INSIGHTFUL' | 'FUNNY';

export type ReadFeedOptions = {
  limit?: number;
  live?: boolean;
  session?: ActionSession;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const FEED_HARVEST_EXPR = `(() => {
  const out = [];
  const seen = {};
  for (const art of document.querySelectorAll('main div[data-urn*="urn:li:activity:"], main .feed-shared-update-v2')) {
    const urn = art.getAttribute('data-urn') || '';
    const m = urn.match(/urn:li:activity:(\\d+)/);
  if (!m) continue;
    const id = m[1];
    if (seen[id]) continue;
    seen[id] = 1;
    const authorEl = art.querySelector('.update-components-actor__name, a.update-components-actor__meta-link');
    const textEl = art.querySelector('.feed-shared-update-v2__description, .update-components-text');
    const author = (authorEl && authorEl.textContent || '').trim();
    const text = (textEl && textEl.textContent || '').trim();
    out.push({ activityUrn: 'urn:li:activity:' + id, activityId: id, author, text });
  }
  return out;
})()`;

function randInt(random: () => number, lo: number, hi: number): number {
  return Math.floor(lo + random() * (hi - lo + 1));
}

export async function readFeed(opts: ReadFeedOptions = {}): Promise<{ status: 'dry_run'; limit: number } | { status: 'ok'; posts: FeedPost[] }> {
  const limit = opts.limit ?? 20;
  if (!opts.live) return { status: 'dry_run', limit };
  const session = opts.session;
  if (!session) throw new Error('session required');
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => actionSleep(ms));
  const { cdp, evaluate } = session;

  await navigate(cdp, 'https://www.linkedin.com/feed/');
  const posts: FeedPost[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < 40 && posts.length < limit; i++) {
    if (i % 4 === 0) await focusForInput(cdp);
    if (i % 6 === 0) await bringToFront(cdp);
    const x = randInt(random, 380, 620);
    const y = randInt(random, 560, 840);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: randInt(random, 900, 2200) }, 5_000);
    await sleep(randInt(random, 800, 1800));
    const harvested = await evaluate(FEED_HARVEST_EXPR);
    if (Array.isArray(harvested)) {
      for (const row of harvested) {
        if (!row || typeof row !== 'object') continue;
        const id = String((row as FeedPost).activityId ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        posts.push(row as FeedPost);
        if (posts.length >= limit) break;
      }
    }
  }
  return { status: 'ok', posts: posts.slice(0, limit) };
}

export type ReactToPostOptions = {
  activityUrn: string;
  reaction?: FeedReaction;
  live?: boolean;
  session?: ActionSession;
  useVoyagerFallback?: boolean;
};

export function buildReactExpr(activityUrn: string, reaction: string): string {
  return `(() => {
  const art = [...document.querySelectorAll('[data-urn]')].find(e => (e.getAttribute('data-urn')||'') === ${JSON.stringify(activityUrn)});
  if (!art) return { ok: false, reason: 'post_missing' };
  const btn = art.querySelector('button[aria-label*="React" i], button.react-button__trigger');
  if (!btn) return { ok: false, reason: 'react_missing' };
  btn.click();
  const choice = [...document.querySelectorAll('button[aria-label]')].find(b => new RegExp(${JSON.stringify(reaction)}, 'i').test(b.getAttribute('aria-label')||''));
  if (choice) choice.click();
  const pressed = art.querySelector('button[aria-pressed="true"], button.react-button--active');
  return { ok: !!pressed, pressed: !!pressed };
})()`;
}

export async function reactToPost(opts: ReactToPostOptions): Promise<{ status: 'dry_run'; activityUrn: string } | { status: string; pressed?: boolean }> {
  if (!opts.live) return { status: 'dry_run', activityUrn: opts.activityUrn };
  const session = opts.session;
  if (!session) throw new Error('session required');
  // useVoyagerFallback defaults off. No captured react endpoint exists, so the flag never calls a guessed Voyager URL.
  void opts.useVoyagerFallback;
  const reaction = opts.reaction ?? 'LIKE';
  const raw = await session.evaluate(buildReactExpr(opts.activityUrn, reaction));
  if (raw && typeof raw === 'object') {
    const r = raw as { ok?: boolean; pressed?: boolean; reason?: string };
    return { status: r.ok ? 'reacted' : 'manual_review', pressed: r.pressed, ...(r.reason ? { reason: r.reason } : {}) };
  }
  return { status: 'manual_review' };
}

export type SharePostOptions = {
  activityUrn: string;
  text?: string;
  live?: boolean;
  session?: ActionSession;
};

export async function sharePost(opts: SharePostOptions): Promise<{ status: 'dry_run' } | { status: string; dialogOpen?: boolean }> {
  if (!opts.live) return { status: 'dry_run' };
  const session = opts.session;
  if (!session) throw new Error('session required');
  const raw = await session.evaluate(`(() => {
    const art = [...document.querySelectorAll('[data-urn]')].find(e => (e.getAttribute('data-urn')||'') === ${JSON.stringify(opts.activityUrn)});
    if (!art) return { ok: false, reason: 'post_missing' };
    const btn = [...art.querySelectorAll('button')].find(b => /repost|share/i.test(b.getAttribute('aria-label')||b.innerText||''));
    if (!btn) return { ok: false, reason: 'share_missing' };
    btn.click();
    const dialog = document.querySelector('motion.div[data-test-modal], div.share-box-v2, div[role="dialog"]');
    return { ok: !!dialog, dialogOpen: !!dialog };
  })()`);
  const r = raw as { ok?: boolean; dialogOpen?: boolean };
  if (!r?.ok) return { status: 'manual_review', dialogOpen: false };
  const hasText = Boolean(opts.text?.trim());
  if (hasText) {
    const filled = (await session.evaluate(`(() => {
      const box = document.querySelector('div[role="dialog"] [contenteditable="true"]');
      if (box) { box.textContent = ${JSON.stringify(opts.text ?? '')}; }
      return { ok: !!box };
    })()`)) as { ok?: boolean };
    if (!filled?.ok) return { status: 'manual_review', dialogOpen: true };
    return { status: 'share_ready', dialogOpen: true };
  }
  return { status: 'share_dialog_open', dialogOpen: true };
}

export type FeedComment = { urn: string; author: string; text: string };

export async function listComments(
  activityUrn: string,
  opts: { live?: boolean; session?: ActionSession } = {},
): Promise<{ status: 'dry_run' } | { status: 'ok'; comments: FeedComment[] }> {
  if (!opts.live) return { status: 'dry_run' };
  const session = opts.session;
  if (!session) throw new Error('session required');
  await navigate(session.cdp, `https://www.linkedin.com/feed/update/${encodeURIComponent(activityUrn)}/`);
  const raw = await session.evaluate(`(() => {
    const comments = [...document.querySelectorAll('article.comments-comment-item, li.comments-comment-item')];
    return comments.map(c => {
      const urn = c.getAttribute('data-urn') || '';
      const author = (c.querySelector('.comments-post-meta__name-text, a')?.textContent || '').trim();
      const text = (c.querySelector('.comments-comment-item__main-content')?.textContent || '').trim();
      return { urn, author, text };
    });
  })()`);
  return { status: 'ok', comments: Array.isArray(raw) ? (raw as FeedComment[]) : [] };
}

export async function replyToComment(
  commentUrn: string,
  text: string,
  opts: { live?: boolean; session?: ActionSession } = {},
): Promise<{ status: 'dry_run' } | { status: string }> {
  if (!opts.live) return { status: 'dry_run' };
  const session = opts.session;
  if (!session) throw new Error('session required');
  const raw = await session.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-urn]')].find(e => (e.getAttribute('data-urn')||'') === ${JSON.stringify(commentUrn)});
    if (!row) return { ok: false, reason: 'comment_missing' };
    const reply = [...row.querySelectorAll('button')].find(b => /reply/i.test(b.getAttribute('aria-label')||b.innerText||''));
    if (!reply) return { ok: false, reason: 'reply_missing' };
    reply.click();
    const editor = document.querySelector('main [contenteditable="true"][role="textbox"]');
    if (!editor) return { ok: false, reason: 'editor_missing' };
    editor.textContent = ${JSON.stringify(text)};
    return { ok: true };
  })()`);
  const r = raw as { ok?: boolean };
  return { status: r?.ok ? 'reply_composed' : 'manual_review' };
}