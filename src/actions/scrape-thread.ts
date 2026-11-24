import type { ParsedMessage } from '../parse/messaging.js';
import { threadIdFromUrn } from './send-message.js';
import { focusForInput, settleDelay, type SettleRange } from './cdp-util.js';
import type { ScrapeSession } from './scrape-connections.js';

export type PullThreadOptions = {
  maxIterations?: number;
  stableRounds?: number;
  bringToFrontEvery?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
  wheelSettle?: SettleRange;
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function resolveDateHeading(text: string, now: Date = new Date()): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'today') return formatLocalDate(now);
  if (lower === 'yesterday') {
    const date = new Date(now);
    date.setDate(date.getDate() - 1);
    return formatLocalDate(date);
  }
  const dayIdx = WEEKDAYS.indexOf(lower as (typeof WEEKDAYS)[number]);
  if (dayIdx >= 0) {
    const date = new Date(now);
    const diff = (now.getDay() - dayIdx + 7) % 7 || 7;
    date.setDate(date.getDate() - diff);
    return formatLocalDate(date);
  }
  if (!/^[A-Za-z]{3,9}\.?\s+\d{1,2}$/.test(raw)) return null;
  const parsed = new Date(`${raw} ${now.getFullYear()}`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getTime() > now.getTime()) parsed.setFullYear(parsed.getFullYear() - 1);
  return formatLocalDate(parsed);
}

type RawThreadRow = {
  sender?: string;
  text?: string;
  subject?: string;
  dateHeading?: string;
  time?: string;
};

export function resolveThreadTimestamp(row: { dateHeading?: string; time?: string }, now: Date): string | null {
  const dateStr = row.dateHeading ? resolveDateHeading(row.dateHeading, now) : null;
  const time = row.time?.trim() ?? '';
  if (dateStr && time) {
    const combined = new Date(`${dateStr} ${time}`);
    if (!Number.isNaN(combined.getTime())) return combined.toISOString();
    return `${dateStr} ${time}`;
  }
  if (dateStr) return dateStr;
  if (time) return time;
  return null;
}

const MESSAGE_COUNT_EXPR = `document.querySelectorAll('li.msg-s-message-list__event').length`;

const LIST_BOX_EXPR = `(function() {
  const el = document.querySelector('.msg-s-message-list');
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
})()`;

const EXTRACT_EXPR = `(function() {
  const messages = [];
  let currentSender = "Unknown";
  let currentDateText = "";
  const allItems = document.querySelectorAll('ul.msg-s-message-list-content > li.msg-s-message-list__event');
  for (const li of allItems) {
    const timeHeading = li.querySelector('time.msg-s-message-list__time-heading');
    if (timeHeading) currentDateText = timeHeading.textContent.trim();
    const nameEl = li.querySelector('.msg-s-message-group__name');
    if (nameEl) currentSender = nameEl.textContent.trim();
    const bodyEl = li.querySelector('.msg-s-event-listitem__body');
    if (!bodyEl) continue;
    const text = bodyEl.textContent.trim();
    if (!text) continue;
    const tsEl = li.querySelector('time.msg-s-message-group__timestamp');
    const subjectEl = li.querySelector('h3.msg-s-event-listitem__subject');
    messages.push({
      sender: currentSender,
      text,
      subject: subjectEl ? subjectEl.textContent.trim() : "",
      dateHeading: currentDateText,
      time: tsEl ? tsEl.textContent.trim() : "",
    });
  }
  return JSON.stringify(messages);
})()`;

function randBetween(random: () => number, lo: number, hi: number): number {
  return lo + random() * (hi - lo);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function asRows(raw: unknown): RawThreadRow[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is RawThreadRow => !!row && typeof row === 'object');
}

export async function pullThread(
  session: ScrapeSession,
  conversationUrn: string,
  opts: PullThreadOptions = {},
): Promise<ParsedMessage[] | null> {
  const threadId = threadIdFromUrn(conversationUrn);
  if (!threadId) return null;
  const maxIterations = opts.maxIterations ?? 100;
  const stableLimit = opts.stableRounds ?? 8;
  const every = opts.bringToFrontEvery ?? 8;
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? ((ms: number) => settleDelay({ minMs: ms, maxMs: ms }));
  const now = opts.now ?? new Date();
  const wheelSettle = opts.wheelSettle ?? { minMs: 900, maxMs: 1_700 };
  const { cdp, evaluate } = session;

  await cdp.send('Page.enable', {}, 5_000);
  await focusForInput(cdp);
  await cdp.send('Page.navigate', { url: `https://www.linkedin.com/messaging/thread/${threadId}/` }, 15_000);
  await sleep(randBetween(random, 900, 1_800));

  const initial = Number(await evaluate(MESSAGE_COUNT_EXPR));
  if (!Number.isFinite(initial) || initial <= 0) return null;

  const boxRaw = await evaluate(LIST_BOX_EXPR);
  if (!boxRaw) return null;
  const box = (typeof boxRaw === 'string' ? JSON.parse(boxRaw) : boxRaw) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  if (!box || !Number.isFinite(box.width) || box.width <= 0) return null;

  let prevCount = initial;
  let stableRounds = 0;
  for (let i = 0; i < maxIterations && stableRounds < stableLimit; i++) {
    if (i % every === 0) await focusForInput(cdp);
    const spanX = Math.max(6, box.width * 0.12);
    const spanY = Math.max(6, box.height * 0.12);
    const x = clamp(box.x + box.width / 2 + (random() - 0.5) * spanX, box.x + 2, box.x + box.width - 2);
    const y = clamp(box.y + Math.min(50, box.height / 3) + (random() - 0.5) * spanY, box.y + 2, box.y + box.height - 2);
    const deltaY = Math.round(randBetween(random, -1_050, -650));
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY }, 5_000);
    } catch {
      await sleep(400);
      continue;
    }
    await sleep(randBetween(random, wheelSettle.minMs, wheelSettle.maxMs));
    const current = Number(await evaluate(MESSAGE_COUNT_EXPR)) || prevCount;
    if (current === prevCount) stableRounds++;
    else {
      stableRounds = 0;
      prevCount = current;
    }
  }

  if (prevCount <= 0) return null;
  const rows = asRows(await evaluate(EXTRACT_EXPR));
  return rows
    .filter((row) => typeof row.text === 'string' && row.text.trim())
    .map((row) => ({
      sender: row.sender?.trim() || 'Unknown',
      text: row.text!.trim(),
      subject: row.subject?.trim() ?? '',
      timestamp: resolveThreadTimestamp({ dateHeading: row.dateHeading, time: row.time }, now),
    }));
}
