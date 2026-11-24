export type ParsedParticipant = {
  name: string;
  profileUrn: string;
  headline: string;
};

export type ParsedMessage = {
  sender: string;
  text: string;
  subject: string;
  timestamp: string | null;
};

export type ParsedConversation = {
  conversationUrn: string;
  participants: ParsedParticipant[];
  lastActivityAt: string | null;
  createdAt: string | null;
  unreadCount: number;
  read: boolean;
  title: string;
  lastMessagePreview: string;
  messages: ParsedMessage[];
};

type ParticipantInput = {
  hostIdentityUrn?: string;
  participantType?: {
    member?: {
      firstName?: { text?: string };
      lastName?: { text?: string };
      headline?: { text?: string };
    };
  };
};

export function participantName(p: ParticipantInput | null | undefined): string | null {
  const member = p?.participantType?.member;
  if (member) {
    const first = member.firstName?.text || '';
    const last = member.lastName?.text || '';
    return `${first} ${last}`.trim() || null;
  }
  return null;
}

export function getConversationCollection(raw: { data?: Record<string, unknown> } | null): { elements?: unknown[] } | null {
  if (!raw?.data) return null;
  const data = raw.data;
  return (
    (data['messengerConversationsByCategoryQuery'] as { elements?: unknown[] } | undefined) ??
    (data['messengerConversationsBySyncToken'] as { elements?: unknown[] } | undefined) ??
    null
  );
}

export function parseConversations(raw: { error?: unknown; data?: Record<string, unknown> } | null): ParsedConversation[] {
  if (!raw || raw.error) return [];

  const collection = getConversationCollection(raw);
  const elements = (collection?.elements ?? []) as Array<Record<string, unknown>>;
  const conversations: ParsedConversation[] = [];

  for (const el of elements) {
    if (!el) continue;

    const participants = ((el['conversationParticipants'] as ParticipantInput[] | undefined) ?? []).map((p) => ({
      name: participantName(p) || 'Unknown',
      profileUrn: (p.hostIdentityUrn as string) || '',
      headline: p.participantType?.member?.headline?.text || '',
    }));

    const inlineMessages = (
      ((el['messages'] as { elements?: Array<Record<string, unknown>> } | undefined)?.elements) ?? []
    ).map((msg) => ({
      sender:
        participantName(msg['actor'] as ParticipantInput) ||
        participantName(msg['sender'] as ParticipantInput) ||
        'Unknown',
      text: ((msg['body'] as { text?: string } | undefined)?.text) || '',
      subject: (msg['subject'] as string) || '',
      timestamp: msg['deliveredAt'] ? new Date(msg['deliveredAt'] as number).toISOString() : null,
    }));

    conversations.push({
      conversationUrn: (el['entityUrn'] as string) || '',
      participants,
      lastActivityAt: el['lastActivityAt'] ? new Date(el['lastActivityAt'] as number).toISOString() : null,
      createdAt: el['createdAt'] ? new Date(el['createdAt'] as number).toISOString() : null,
      unreadCount: (el['unreadCount'] as number) || 0,
      read: (el['read'] as boolean | undefined) ?? true,
      title: ((el['title'] as { text?: string } | undefined)?.text) || '',
      lastMessagePreview: inlineMessages[0]?.text?.substring(0, 200) || '',
      messages: inlineMessages,
    });
  }

  return conversations;
}

export function parseMessages(raw: { error?: unknown; data?: Record<string, unknown> } | null): ParsedMessage[] {
  if (!raw || raw.error) return [];

  const elements =
    ((raw.data?.['messengerMessagesBySyncToken'] as { elements?: Array<Record<string, unknown>> } | undefined)
      ?.elements) ?? [];
  const messages: ParsedMessage[] = [];

  for (const el of elements) {
    if (!el) continue;
    const body = ((el['body'] as { text?: string } | undefined)?.text) || '';
    if (!body) continue;

    messages.push({
      sender:
        participantName(el['actor'] as ParticipantInput) ||
        participantName(el['sender'] as ParticipantInput) ||
        'Unknown',
      text: body,
      subject: (el['subject'] as string) || '',
      timestamp: el['deliveredAt'] ? new Date(el['deliveredAt'] as number).toISOString() : null,
    });
  }

  return messages.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
}