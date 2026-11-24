const TLD = '(?:com|org|net|io|co|ly)';
const LINK_RE = new RegExp(
  [
    '\\bhttps?:\\/\\/',
    '\\bwww\\.',
    '(?:\\w+\\.)+' + TLD + '\\b',
    '\\[\\s*\\.\\s*\\]\\s*' + TLD,
    '(?:\\bdot\\b|\\(dot\\))\\s*' + TLD + '\\b',
    '\\w+\\s+\\.\\s+' + TLD + '\\b',
    'evil\\[\\.\\]com',
  ].join('|'),
  'i',
);
const MENTION_RE = /@/;
const HASHTAG_RE = /#/;
const PHONEISH_RE = /\d{9,}/;
const ZW_AND_BIDI =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u00AD]/;

const DISALLOWED_OUTSIDE_LATIN =
  /[^\n\t\x20-\x7E\u00A1-\u024F\u2000-\u206F\u2190-\u27BF\u2600-\u27BF]/u;

export type ContentFilterResult =
  | { ok: true }
  | { ok: false; violations: string[] };

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function longestSharedWordRun(a: string, b: string): number {
  const aw = words(a);
  const bw = new Set(words(b));
  let best = 0;
  let run = 0;
  for (const w of aw) {
    if (bw.has(w)) {
      run++;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  return best;
}

export function filterCommentContent(text: string, sourceText = ''): ContentFilterResult {
  const violations: string[] = [];
  const normalized = text.normalize('NFC');
  const compat = normalized.normalize('NFKC');

  if (ZW_AND_BIDI.test(normalized) || ZW_AND_BIDI.test(compat)) {
    violations.push('unsupported_character');
  }
  if (DISALLOWED_OUTSIDE_LATIN.test(compat)) {
    violations.push('unsupported_character');
  }
  if (MENTION_RE.test(normalized)) violations.push('mention');
  if (HASHTAG_RE.test(normalized)) violations.push('hashtag');
  if (LINK_RE.test(compat)) violations.push('link');
  if (PHONEISH_RE.test(compat.replace(/\s+/g, ''))) violations.push('contact_digits');
  if (sourceText && longestSharedWordRun(normalized, sourceText) >= 8) {
    violations.push('copied_span');
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}

/** Benign prose that must pass the filter (regression fixture). */
export const BENIGN_COMMENT_SAMPLE =
  'Appreciate the thoughtful breakdown here. The tradeoff between latency and cost is often understated in these architectures.';

export const BENIGN_COUNTER_CASES = [
  'Them vs. Us is a common framing mistake.',
  'The team ships Node.js services in production.',
  'We planned capacity for 2024-2025.',
];