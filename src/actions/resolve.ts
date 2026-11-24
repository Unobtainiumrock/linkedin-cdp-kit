import type { ParsedConversation } from '../parse/messaging.js';

export function normalizeName(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .replace(/[.,'`’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type NameMatch = ParsedConversation & {
  matchedParticipant: ParsedConversation['participants'][number];
};

export function matchConversationsByName(
  conversations: ParsedConversation[] | null | undefined,
  query: string,
  opts: { selfName?: string } = {},
): NameMatch[] {
  const q = normalizeName(query);
  if (!q) return [];
  const qTokens = q.split(' ').filter(Boolean);
  const self = normalizeName(opts.selfName || '');

  const out: NameMatch[] = [];
  for (const convo of conversations ?? []) {
    const candidates = convo.participants.filter((p) => {
      const n = normalizeName(p.name);
      if (!n) return false;
      if (self && n === self) return false;
      return qTokens.every((t) => n.includes(t));
    });
    if (candidates.length > 0 && candidates[0]) {
      out.push({ ...convo, matchedParticipant: candidates[0] });
    }
  }
  return out;
}