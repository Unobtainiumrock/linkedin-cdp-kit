const FILTER_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0a, 0x0a],
  [0x20, 0x7e],
  [0xa0, 0xac],
  [0xae, 0x24f],
  [0x1e00, 0x1eff],
  [0x2010, 0x2027],
  [0x2030, 0x205e],
  [0x20a0, 0x20c0],
  [0x2190, 0x23ff],
  [0x25a0, 0x27bf],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
];

const FOLD_PAIRS =
  'ÆAE ÐD ØO æae ðd øo ĐD đd ĦH ħh ıi ĸk ŁL łl ŊN ŋn ŒOE œoe ŦT ŧt ƀb ƁB ƂB ƃb ƆO ƇC ƈc ƊD ƋD ƌd ƎE ƐE ƑF ƒf ƓG Ɩl ƗI ƘK ƙk ƚl ƝN ƞn ƟO ƤP ƥp ƫt ƬT ƭt ƮT ƲV ƳY ƴy ƵZ ƶz ǀl ǁll ǝe ǤG ǥg ȠN ȡd ȤZ ȥz ȴl ȵn ȶt ȷj ȺA ȻC ȼc ȽL ȾT ȿs ɀz ɃB ɆE ɇe ɈJ ɉj ɋq ɌR ɍr ɎY ɏy ỾY ỿy þo ÞO ßss';
const FOLD: Record<string, string> = {};
for (const pair of FOLD_PAIRS.split(' ')) {
  if (pair.length >= 2) FOLD[pair[0]!] = pair.slice(1);
}
const FOLDABLE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'u');
const DASHES = /[\u2010-\u2015\u2212]/g;
const DINGBAT_DIGITS = /[\u2776-\u2793]/g;
const BULLETS = '\u2022\u2023\u2043\u25cf\u25e6\u2218\u00b7\u2219\u22c5';
const LINE_BULLET = new RegExp(`(^|\\n)( *)[${BULLETS}]`, 'g');
const DOTS = new RegExp(`[${BULLETS}\u3002\uff61\ufe52\u2027\u30fb]`, 'g');
const JOIN_DOTTED = /(\.[a-z0-9]+) *\n+ *(?=[^\W_])/g;
const PHONE_GROUP = /(?<![^\W\d_])[0-9oOlI]+(?![^\W\d_])/g;
const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
const TLDS = new Set(['com', 'net', 'org', 'io', 'ai', 'app', 'dev', 'xyz', 'me', 'ly', 'co', 'us', 'info', 'biz', 'gg', 'so', 'sh']);
const TLD_ENDING = /(?<=[^\W_])\.([a-z0-9]{2,4})(?![^\W_])/g;
const PHONE = /[0-9](?:(?:[\W_]|[oOxX]){0,3}[0-9])*/g;
const TLD =
  '(?:com|net|org|io|ai|app|dev|xyz|me|ly|co|us|info|biz|gg|so|sh)(?![A-Za-z0-9])';
const LINK_PATTERNS = [
  /https?:/,
  /(?<![a-z0-9])www\./,
  /(?<![^\W_])(?<!-)[^\W_](?:[^\W_]|-)*\.[^\W\d_]{2,}(?![^\W_])/,
  /(?<![^\W_])(?<!\.)[0-9]{1,3}(?:\.[0-9]{1,3}){3}(?![^\W_]|\.[0-9])/,
  new RegExp(`[a-z0-9][ \\n]+\\.[ \\n]*${TLD}`),
  new RegExp(`[a-z0-9][ \\n]*[\\[({<][ \\n]*(?:\\.|dot)[ \\n]*[\\])}>][ \\n]*${TLD}`),
  new RegExp(`[a-z0-9][ \\n]+dot[ \\n]+${TLD}`),
];
const SPLIT_PATTERN = new RegExp(`[A-Za-z0-9]\\.[ \\n]+${TLD}`);

const COPY_RUN = 8;

export type ContentFilterViolation =
  | 'unsupported_character'
  | 'mention'
  | 'link'
  | 'contact_digits'
  | 'hashtag'
  | 'copied_span';

export type ContentFilterResult = { ok: true } | { ok: false; violations: ContentFilterViolation[] };

function allowedChar(code: number): boolean {
  return FILTER_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

function allowedText(text: string): boolean {
  for (const ch of text) {
    if (!allowedChar(ch.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

function stripCombiningMarks(text: string): string {
  const nfkd = text.normalize('NFKD');
  let out = '';
  for (const ch of nfkd) {
    const cat = /\p{M}/u.test(ch) ? 'M' : 'L';
    if (cat !== 'M') out += ch;
  }
  return out;
}

function applyLatinFolds(text: string): string {
  let out = text;
  for (const [from, to] of Object.entries(FOLD)) {
    if (from) out = out.split(from).join(to);
  }
  return out;
}

function skeleton(text: string): string {
  let s = stripCombiningMarks(text);
  s = s.replace(DASHES, '-');
  s = applyLatinFolds(s);
  s = s.replace(DINGBAT_DIGITS, (m) => {
    const cp = m.codePointAt(0) ?? 0;
    return String(((cp - 0x2776) % 10) + 1);
  });
  s = s.replace(LINE_BULLET, '$1$2 ').replace(DOTS, '.');
  return s;
}

function digitTld(lower: string): boolean {
  for (const m of lower.matchAll(TLD_ENDING)) {
    const end = m[1] ?? '';
    if (/[0-9]/.test(end) && /[a-z]/.test(end)) {
      for (const one of ['l', 'i'] as const) {
        const folded = end.replace(/0/g, 'o').replace(/3/g, 'e').replace(/1/g, one);
        if (TLDS.has(folded)) return true;
      }
    }
  }
  return false;
}

function phoneLike(s: string): boolean {
  const squashed = s.replace(/ {2,}/g, ' ').replace(/-{2,}/g, '-');
  const view = squashed.replace(PHONE_GROUP, (m) =>
    /[0-9]/.test(m) ? m.replace(/[lI]/g, '1').replace(/[oO]/g, '0') : m,
  );
  for (const run of view.match(PHONE) ?? []) {
    const digits = run.replace(/[^0-9]/g, '');
    if (digits.length >= 9) return true;
  }
  return false;
}

export function tokenizeFilterWords(text: string): string[] {
  const spaced = text.replace(SPACES, ' ');
  const nfc = spaced.normalize('NFC');
  const kept = [...nfc].filter((c) => allowedChar(c.codePointAt(0) ?? 0)).join('');
  const skel = skeleton(kept).toLowerCase();
  return skel.match(/[^\W_]+/gu) ?? [];
}

export function contentRefusal(text: string, sourceText = ''): ContentFilterViolation | null {
  const composed = String(text).normalize('NFC');
  if (!allowedText(composed)) return 'unsupported_character';
  const t = composed.normalize('NFKC');
  if (!allowedText(t)) return 'unsupported_character';
  if (/[@\uff20]/.test(t)) return 'mention';
  const s = skeleton(t);
  const joined = s.replace(JOIN_DOTTED, '$1');
  const lower = joined.toLowerCase();
  if (LINK_PATTERNS.some((r) => r.test(lower)) || SPLIT_PATTERN.test(joined) || digitTld(lower)) {
    return 'link';
  }
  if (phoneLike(s)) return 'contact_digits';
  if (/#\w/.test(s)) return 'hashtag';
  const src = tokenizeFilterWords(sourceText);
  const own = tokenizeFilterWords(t);
  const runs = new Set<string>();
  for (let i = 0; i <= src.length - COPY_RUN; i++) {
    runs.add(src.slice(i, i + COPY_RUN).join('\0'));
  }
  for (let i = 0; i <= own.length - COPY_RUN; i++) {
    if (runs.has(own.slice(i, i + COPY_RUN).join('\0'))) return 'copied_span';
  }
  return null;
}

export function filterCommentContent(text: string, sourceText = ''): ContentFilterResult {
  const refusal = contentRefusal(text, sourceText);
  if (!refusal) return { ok: true };
  return { ok: false, violations: [refusal] };
}

export function longestSharedWordRun(a: string, b: string): number {
  const aw = tokenizeFilterWords(a);
  const bw = new Set(tokenizeFilterWords(b));
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

/** Benign prose that must pass the filter (regression fixture). */
export const BENIGN_COMMENT_SAMPLE =
  'Appreciate the thoughtful breakdown here. The tradeoff between latency and cost is often understated in these architectures.';

export const BENIGN_COUNTER_CASES = [
  'Them vs. Us is a common framing mistake.',
  'The team ships Node.js services in production.',
  'We planned capacity for 2024-2025.',
];

export type ContentFilterCase = {
  name: string;
  text: string;
  source: string;
  expected: 'pass' | ContentFilterViolation;
};