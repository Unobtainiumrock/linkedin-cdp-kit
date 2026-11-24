export type MessageIntent =
  | 'inbound_pitch'
  | 'question'
  | 'proposed_time'
  | 'shared_link'
  | 'not_interested'
  | 'positive_confirm'
  | 'other'
  | (string & {});

export type IntentClassification = {
  intent: MessageIntent;
  confidence: number;
  terminal?: boolean;
};

export interface IntentRouter {
  classify(
    inbound: { text: string; fingerprint: string },
  ): IntentClassification | Promise<IntentClassification>;
}

export interface ReplyStrategy {
  readonly intent: MessageIntent;
  draft(
    inbound: { text: string; conversationUrn: string },
    ctx: VoiceAndContext,
  ): { text: string; terminal?: boolean } | Promise<{ text: string; terminal?: boolean }>;
}

export type VoiceAndContext = {
  voice: string;
  product: string;
  rules: string;
};

export function loadVoiceAndContext(files: { voice?: string; product?: string; rules?: string }): VoiceAndContext {
  return {
    voice: files.voice ?? '',
    product: files.product ?? '',
    rules: files.rules ?? '',
  };
}

export type HandoffActionInput = {
  conversationUrn: string;
  intent: MessageIntent;
  threadState: string;
};

export interface HandoffAction {
  readonly id: string;
  shouldHandoff(input: HandoffActionInput): boolean;
  execute(input: HandoffActionInput): Promise<{ ok: boolean; detail?: string }>;
}

export interface SchedulingAdapter {
  readonly id: string;
  proposeSlots(input: { conversationUrn: string }): Promise<string[]>;
}

export class KeywordIntentRouter implements IntentRouter {
  classify(inbound: { text: string }): IntentClassification {
    const t = inbound.text.toLowerCase();
    if (/not interested|unsubscribe|stop/i.test(t)) return { intent: 'not_interested', confidence: 0.9, terminal: true };
    if (/calendar|schedule|meet|time slot/i.test(t)) return { intent: 'proposed_time', confidence: 0.8 };
    if (/https?:\/\//i.test(t)) return { intent: 'shared_link', confidence: 0.7 };
    if (/\?/.test(t)) return { intent: 'question', confidence: 0.6 };
    if (/pitch|demo|product/i.test(t)) return { intent: 'inbound_pitch', confidence: 0.6 };
    if (/sounds good|let's do|confirmed/i.test(t)) return { intent: 'positive_confirm', confidence: 0.7 };
    return { intent: 'other', confidence: 0.3 };
  }
}

export class TerminalNotInterestedStrategy implements ReplyStrategy {
  readonly intent: MessageIntent = 'not_interested';
  draft(): { text: string; terminal: boolean } {
    return { text: '', terminal: true };
  }
}

export class TemplateReplyStrategy implements ReplyStrategy {
  constructor(
    readonly intent: MessageIntent,
    private readonly template: string,
  ) {}
  draft(inbound: { text: string }): { text: string } {
    return { text: this.template.replace('{{inbound}}', inbound.text.slice(0, 200)) };
  }
}

export async function routeAndDraft(
  router: IntentRouter,
  strategies: ReplyStrategy[],
  inbound: { text: string; fingerprint: string; conversationUrn: string },
  voice: VoiceAndContext,
): Promise<{ intent: MessageIntent; text: string; terminal: boolean }> {
  const cls = await router.classify(inbound);
  if (cls.terminal) return { intent: cls.intent, text: '', terminal: true };
  const strat = strategies.find((s) => s.intent === cls.intent) ?? strategies.find((s) => s.intent === 'other');
  if (!strat) return { intent: cls.intent, text: '', terminal: false };
  const out = await strat.draft(inbound, voice);
  return { intent: cls.intent, text: out.text, terminal: Boolean(out.terminal) };
}

export class NoopHandoffAction implements HandoffAction {
  readonly id = 'noop';
  shouldHandoff(input: HandoffActionInput): boolean {
    return input.intent === 'proposed_time' && input.threadState === 'booking';
  }
  async execute(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}