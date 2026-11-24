export type ParsedRealtimeMessage = {
  sender: string;
  text: string;
  conversationUrn: string;
  timestamp: string;
  subject: string;
};

type EventShape = Record<string, unknown>;

export function extractMessageFromEvent(event: EventShape | null | undefined): ParsedRealtimeMessage | null {
  if (!event) return null;

  const body =
    (event['body'] as { text?: string } | undefined)?.text ||
    (event['message'] as { body?: { text?: string } } | undefined)?.body?.text ||
    (event['eventContent'] as { messageEvent?: { body?: { text?: string } } } | undefined)?.messageEvent?.body?.text ||
    (event['payload'] as { body?: { text?: string } } | undefined)?.body?.text;

  if (!body || body.length < 2) return null;

  const actor = (event['actor'] as { firstName?: { text?: string }; lastName?: { text?: string } }) ??
    (event['message'] as { actor?: { firstName?: { text?: string }; lastName?: { text?: string } } })?.actor;
  const from = event['from'] as { firstName?: string; lastName?: string } | undefined;

  const senderFirst = actor?.firstName?.text ?? from?.firstName ?? 'Unknown';
  const senderLast = actor?.lastName?.text ?? from?.lastName ?? '';

  const conversationUrn =
    (event['conversationUrn'] as string) ||
    (event['conversation'] as { entityUrn?: string } | undefined)?.entityUrn ||
    (event['parentUrn'] as string) ||
    '';

  const timestamp = event['deliveredAt']
    ? new Date(event['deliveredAt'] as number).toISOString()
    : new Date().toISOString();

  return {
    sender: `${senderFirst} ${senderLast}`.trim(),
    text: body,
    conversationUrn,
    timestamp,
    subject: (event['subject'] as string) || '',
  };
}

export function parseLinkedInFrame(payload: string): ParsedRealtimeMessage | null {
  try {
    const data = JSON.parse(payload) as EventShape;

    if (
      data['topic'] === '/messaging/conversations' ||
      data['topic'] === '/messaging/realtime' ||
      data['$type'] === 'com.linkedin.voyager.messaging.event.MessageEvent'
    ) {
      return extractMessageFromEvent(data);
    }

    const nested = data['data'] as { payload?: unknown } | undefined;
    if (nested?.payload) {
      return parseLinkedInFrame(JSON.stringify(nested.payload));
    }

    if (Array.isArray(data)) {
      for (const item of data) {
        const result = extractMessageFromEvent(item as EventShape);
        if (result) return result;
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}