import { pathToFileURL } from 'node:url';
import {
  KeywordIntentRouter,
  TemplateReplyStrategy,
  TerminalNotInterestedStrategy,
  type IntentRouter,
  type ReplyStrategy,
  type VoiceAndContext,
} from '../pipeline/messaging-plugins.js';

export type HooksModule = {
  qualify?: (candidate: { slug: string; name: string }) => { decision: 'qualify' | 'reject' | 'needs_research'; reason?: string };
  draft?: (post: { text: string; activityId?: string | null }, ctx: { slug: string }) =>
    | Promise<{ text: string } | { skip: true; reason: string }>
    | { text: string }
    | { skip: true; reason: string };
  classify?: (thread: Record<string, unknown>) => Promise<{ label: string } | { skip: true; reason: string }> | { label: string } | { skip: true; reason: string };
  intentRouter?: IntentRouter;
  strategies?: ReplyStrategy[];
  voice?: VoiceAndContext;
};

export function messagingRouterFromHooks(hooks: HooksModule): IntentRouter {
  if (hooks.intentRouter) return hooks.intentRouter;
  if (hooks.classify) {
    return {
      async classify(inbound) {
        const out = await hooks.classify!({ text: inbound.text, fingerprint: inbound.fingerprint });
        if ('skip' in out && out.skip) return { intent: 'other', confidence: 0, terminal: true };
        return { intent: 'label' in out ? out.label : 'other', confidence: 0.5 };
      },
    };
  }
  return new KeywordIntentRouter();
}

export function messagingStrategiesFromHooks(hooks: HooksModule): ReplyStrategy[] {
  if (hooks.strategies && hooks.strategies.length > 0) return hooks.strategies;
  return [
    new TerminalNotInterestedStrategy(),
    new TemplateReplyStrategy('question', 'Thanks for the question. {{inbound}}'),
    new TemplateReplyStrategy('proposed_time', 'Happy to find a time. {{inbound}}'),
    new TemplateReplyStrategy('shared_link', 'Thanks for sending that. {{inbound}}'),
    new TemplateReplyStrategy('inbound_pitch', 'Thanks for the note. {{inbound}}'),
    new TemplateReplyStrategy('positive_confirm', 'Glad that works. {{inbound}}'),
    new TemplateReplyStrategy('other', 'Thanks for the note. {{inbound}}'),
  ];
}

export async function loadHooksModule(filePath: string): Promise<HooksModule> {
  const mod = (await import(pathToFileURL(filePath).href)) as { default?: HooksModule } & HooksModule;
  return mod.default ?? mod;
}