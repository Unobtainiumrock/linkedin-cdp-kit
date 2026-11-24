import { createHash } from 'node:crypto';
import type { ParsedConversation, ParsedMessage } from '../../parse/messaging.js';
import { sanitizeInbound, validateOutbound } from './safety.js';
import { readDrafts, writeDrafts, type MessageDraft } from './queue.js';
import {
  routeAndDraft,
  type IntentRouter,
  type ReplyStrategy,
  type VoiceAndContext,
} from '../../pipeline/messaging-plugins.js';

export function inboundFingerprint(messages: ParsedMessage[], selfName: string | null): string {
  const inbound = messages.filter((m) => m.text && (!selfName || m.sender !== selfName));
  const last = inbound[inbound.length - 1];
  if (!last) return 'none';
  const { sanitized } = sanitizeInbound(last.text);
  return createHash('sha1')
    .update(`${last.sender}|${last.timestamp ?? ''}|${sanitized}`)
    .digest('hex');
}

export function lastSenderIsSelf(messages: ParsedMessage[], selfName: string | null): boolean {
  const msgs = messages.filter((m) => m.text.trim());
  const last = msgs[msgs.length - 1];
  return !!(last && selfName && last.sender === selfName);
}

export type ThreadRecord = {
  conversationUrn: string;
  lastInboundFp: string;
  status: 'new' | 'drafted' | 'approved' | 'sent' | 'send_failed' | 'manually_handled' | 'skipped';
  participantName: string;
};

export function ingestConversation(
  convo: ParsedConversation,
  selfName: string | null,
  prev?: ThreadRecord,
): ThreadRecord {
  const fp = inboundFingerprint(convo.messages, selfName);
  const manual = lastSenderIsSelf(convo.messages, selfName);
  let status: ThreadRecord['status'] = prev?.status ?? 'new';
  if (manual) status = 'manually_handled';
  else if (prev && prev.lastInboundFp !== fp) status = 'new';
  return {
    conversationUrn: convo.conversationUrn,
    lastInboundFp: fp,
    status,
    participantName: convo.participants.find((p) => p.name !== selfName)?.name ?? convo.participants[0]?.name ?? 'Unknown',
  };
}

export type IngestQueueResult = {
  seen: number;
  drafted: number;
  skipped: number;
  terminal: number;
  dryRun: true;
  sent: false;
};

function draftId(conversationUrn: string, inboundFp: string): string {
  return createHash('sha256').update(`${conversationUrn}\n${inboundFp}`).digest('hex').slice(0, 24);
}

function lastInbound(convo: ParsedConversation, selfName: string | null): ParsedMessage | null {
  const inbound = convo.messages.filter((m) => m.text.trim() && (!selfName || m.sender !== selfName));
  return inbound[inbound.length - 1] ?? null;
}

export async function ingestAndQueueDrafts(args: {
  conversations: ParsedConversation[];
  selfName: string | null;
  rootDir: string;
  router: IntentRouter;
  strategies: ReplyStrategy[];
  voice: VoiceAndContext;
}): Promise<IngestQueueResult> {
  const existing = readDrafts(args.rootDir);
  const known = new Set(existing.map((row) => `${row.conversationUrn}\n${row.inboundFp}`));
  const added: MessageDraft[] = [];
  const stats: IngestQueueResult = { seen: 0, drafted: 0, skipped: 0, terminal: 0, dryRun: true, sent: false };

  for (const convo of args.conversations) {
    if (!convo.conversationUrn) continue;
    stats.seen++;
    const record = ingestConversation(convo, args.selfName);
    if (record.status === 'manually_handled' || record.lastInboundFp === 'none') {
      stats.skipped++;
      continue;
    }
    const key = `${record.conversationUrn}\n${record.lastInboundFp}`;
    if (known.has(key)) {
      stats.skipped++;
      continue;
    }
    const inbound = lastInbound(convo, args.selfName);
    if (!inbound) {
      stats.skipped++;
      continue;
    }
    const routed = await routeAndDraft(
      args.router,
      args.strategies,
      { text: inbound.text, fingerprint: record.lastInboundFp, conversationUrn: record.conversationUrn },
      args.voice,
    );
    if (routed.terminal || !routed.text.trim()) {
      stats.terminal++;
      continue;
    }
    const safety = validateOutbound(routed.text);
    if (!safety.ok) {
      stats.skipped++;
      continue;
    }
    const draft: MessageDraft = {
      id: draftId(record.conversationUrn, record.lastInboundFp),
      conversationUrn: record.conversationUrn,
      inboundFp: record.lastInboundFp,
      text: routed.text,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    added.push(draft);
    known.add(key);
    stats.drafted++;
  }

  if (added.length) writeDrafts(args.rootDir, [...existing, ...added]);
  return stats;
}