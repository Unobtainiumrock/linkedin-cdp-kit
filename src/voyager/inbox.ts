import { INBOX_CATEGORIES, buildFetchConversations, type InboxCategory } from './builders.js';
import { parseConversations } from '../parse/messaging.js';
import type { ParsedConversation } from '../parse/messaging.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export type InboxEvaluateSession = {
  csrfToken: string;
  mailboxUrn: string;
  evaluate: (expression: string, timeoutMs?: number) => Promise<unknown>;
};

export type ListConversationsOptions = {
  days?: number;
  count?: number;
  categories?: InboxCategory[];
  full?: boolean;
  nameFilters?: string[];
  log?: (msg: string) => void;
};

export async function listConversations(
  session: InboxEvaluateSession,
  opts: ListConversationsOptions = {},
): Promise<ParsedConversation[]> {
  const { evaluate, csrfToken, mailboxUrn } = session;
  const log = opts.log ?? (() => {});

  const days = Number.isFinite(opts.days) && (opts.days as number) >= 1 ? (opts.days as number) : 7;
  const maxConversations = Number.isFinite(opts.count) && (opts.count as number) >= 1 ? (opts.count as number) : 200;
  const categories = opts.categories?.length ? opts.categories : [...INBOX_CATEGORIES];
  const nameFilters = (opts.nameFilters ?? []).map((s) => s.toLowerCase());
  const backfill = opts.full === true || nameFilters.length > 0;
  const cutoff = new Date(Date.now() - (backfill ? 365 * 10 : days) * DAY_MS);

  const byUrn = new Map<string, ParsedConversation>();

  for (const category of categories) {
    if (byUrn.size >= maxConversations) break;

    let nextCursor: string | null = null;
    let reachedCutoff = false;
    let page = 0;

    while (!reachedCutoff && byUrn.size < maxConversations) {
      page++;
      const rawJson = await evaluate(buildFetchConversations(csrfToken, mailboxUrn, nextCursor, category));
      let raw: { error?: unknown; data?: unknown } | null = null;
      if (typeof rawJson === 'string') {
        try {
          raw = JSON.parse(rawJson) as { error?: unknown; data?: unknown };
        } catch {
          raw = null;
        }
      } else if (rawJson && typeof rawJson === 'object') {
        raw = rawJson as { error?: unknown; data?: unknown };
      }

      if (raw?.error) {
        log(`  [${category}] API error on page ${page}: ${JSON.stringify(raw.error)}`);
        break;
      }

      const batch = parseConversations(raw as { error?: unknown; data?: Record<string, unknown> } | null);
      if (batch.length === 0) break;

      for (const convo of batch) {
        if (convo.lastActivityAt && new Date(convo.lastActivityAt) < cutoff) {
          reachedCutoff = true;
          break;
        }
        if (nameFilters.length) {
          const hit = convo.participants.some((p) =>
            nameFilters.some((f) => p.name.toLowerCase().includes(f)),
          );
          if (!hit) continue;
        }
        if (!byUrn.has(convo.conversationUrn)) byUrn.set(convo.conversationUrn, convo);
        if (byUrn.size >= maxConversations) break;
      }

      const collection = raw as {
        data?: {
          messengerConversationsByCategoryQuery?: { metadata?: { nextCursor?: string } };
        };
      };
      nextCursor =
        collection?.data?.messengerConversationsByCategoryQuery?.metadata?.nextCursor ?? null;
      if (!nextCursor) break;
    }
  }

  return [...byUrn.values()];
}