import type { Store } from '../core/store.js';
import { evaluateGates, type GateConfig } from '../core/gates.js';
import { reserveBeforeClick, finalizeAttempt } from '../core/reserve.js';
import { validateOutbound } from './safety.js';
import { jitteredDelay } from '../../pacing.js';
import type { SendMessageResult } from '../../actions/send-message.js';

export type MessagingConfig = {
  sendEnabled: boolean;
  maxSendsPerDay: number;
  minGapSec: number;
  maxGapSec: number;
  dryRun: boolean;
};

export type SendAttempt = {
  conversationUrn: string;
  text: string;
  inboundFp: string;
};

export type MessageSender = (urn: string, text: string, live: boolean) => Promise<SendMessageResult>;

export function alreadySentForFingerprint(store: Store, conversationUrn: string, fp: string): boolean {
  return store
    .readLedger()
    .some(
      (r) =>
        r.conversationUrn === conversationUrn &&
        r.inboundFp === fp &&
        (r.status === 'sent' || r.status === 'attempting'),
    );
}

export function sentTodayCount(store: Store, dayStartIso: string): number {
  const start = Date.parse(dayStartIso);
  return store.readLedger().filter((r) => r.status === 'sent' && Date.parse(String(r.at)) >= start).length;
}

export async function dispatchOne(
  store: Store,
  attempt: SendAttempt,
  cfg: MessagingConfig,
  gateCfg: GateConfig,
  sender: MessageSender,
): Promise<{ ok: boolean; reason?: string; status?: string }> {
  if (!cfg.sendEnabled) {
    return { ok: false, reason: 'kill_switch', status: 'send_failed' };
  }

  const gate = evaluateGates(store, gateCfg);
  if (!gate.ok) return { ok: false, reason: gate.code };

  if (alreadySentForFingerprint(store, attempt.conversationUrn, attempt.inboundFp)) {
    return { ok: false, reason: 'dedup', status: 'send_failed' };
  }

  const safety = validateOutbound(attempt.text);
  if (!safety.ok) return { ok: false, reason: `safety:${safety.violations.join(',')}`, status: 'send_failed' };

  if (cfg.dryRun) return { ok: false, reason: 'dry_run' };

  const row = reserveBeforeClick(store, {
    status: 'attempting',
    conversationUrn: attempt.conversationUrn,
    inboundFp: attempt.inboundFp,
  });

  let result: SendMessageResult;
  try {
    result = await sender(attempt.conversationUrn, attempt.text, true);
  } catch (err) {
    finalizeAttempt(store, row.id, 'send_failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: 'threw', status: 'send_failed' };
  }

  if (result.ok) {
    finalizeAttempt(store, row.id, 'sent', { conversationUrn: attempt.conversationUrn });
    await jitteredDelay(cfg.minGapSec * 1000, cfg.maxGapSec * 1000);
    return { ok: true, status: 'sent' };
  }

  const reason = result.reason ?? 'send_failed';
  finalizeAttempt(store, row.id, 'send_failed', { conversationUrn: attempt.conversationUrn, reason });
  return { ok: false, reason, status: 'send_failed' };
}