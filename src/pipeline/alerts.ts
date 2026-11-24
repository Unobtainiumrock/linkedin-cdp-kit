import type { HealthCheck, HealthReport } from './health.js';

export interface AlertChannel {
  readonly id: string;
  send(payload: { key: string; state: string; detail: string; fixHint?: string }): Promise<void> | void;
}

export type AlertDispatcherConfig = {
  minIntervalMs: number;
};

export class ConsoleAlertChannel implements AlertChannel {
  readonly id = 'console';
  send(payload: { key: string; state: string; detail: string; fixHint?: string }): void {
    console.log(JSON.stringify({ alert: payload }));
  }
}

export class WebhookAlertChannel implements AlertChannel {
  readonly id = 'webhook';
  constructor(private readonly url: string) {}
  async send(payload: { key: string; state: string; detail: string; fixHint?: string }): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
}

export class AlertDispatcher {
  private lastSent = new Map<string, number>();
  constructor(
    private readonly channels: AlertChannel[],
    private readonly config: AlertDispatcherConfig = { minIntervalMs: 300_000 },
  ) {}

  async dispatch(report: HealthReport, now = Date.now()): Promise<{ sent: string[]; suppressed: string[] }> {
    const sent: string[] = [];
    const suppressed: string[] = [];
    for (const check of report.checks) {
      if (check.state === 'ok') continue;
      const last = this.lastSent.get(check.key) ?? 0;
      if (now - last < this.config.minIntervalMs) {
        suppressed.push(check.key);
        continue;
      }
      const payload = { key: check.key, state: check.state, detail: check.detail, fixHint: check.fixHint };
      for (const ch of this.channels) {
        await Promise.resolve(ch.send(payload));
      }
      this.lastSent.set(check.key, now);
      sent.push(check.key);
    }
    return { sent, suppressed };
  }
}

export function dispatchHealthAlerts(
  dispatcher: AlertDispatcher,
  report: HealthReport,
): Promise<{ sent: string[]; suppressed: string[] }> {
  return dispatcher.dispatch(report);
}