import { createHash } from 'node:crypto';
import type { ParsedConversation, ParsedMessage } from '../../parse/messaging.js';
import { sanitizeInbound } from './safety.js';

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