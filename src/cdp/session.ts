import type { CdpTarget } from './types.js';

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { result?: { value?: unknown } };
  error?: { message?: string };
};

export type CdpSessionOptions = {
  commandTimeoutMs?: number;
  evaluateTimeoutMs?: number;
};

export class CdpSession {
  private ws: WebSocket;
  private nextId = 1000;
  private readonly commandTimeoutMs: number;
  private readonly evaluateTimeoutMs: number;
  private readonly messageHandlers = new Set<(raw: string) => void>();
  private readonly wsMessageBridge: (ev: MessageEvent) => void;
  readonly targetId: string | null;
  readonly wsUrl: string;

  private constructor(ws: WebSocket, meta: { targetId: string | null; wsUrl: string; opts: CdpSessionOptions }) {
    this.ws = ws;
    this.targetId = meta.targetId;
    this.wsUrl = meta.wsUrl;
    this.commandTimeoutMs = meta.opts.commandTimeoutMs ?? 10_000;
    this.evaluateTimeoutMs = meta.opts.evaluateTimeoutMs ?? 30_000;
    this.wsMessageBridge = (ev: MessageEvent) => {
      const data = typeof ev.data === 'string' ? ev.data : ev.data.toString();
      for (const handler of this.messageHandlers) handler(data);
    };
    this.ws.addEventListener('message', this.wsMessageBridge);
  }

  static async connect(wsUrl: string, meta: { targetId?: string | null } = {}, opts: CdpSessionOptions = {}): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP WebSocket connection timeout'));
      }, opts.commandTimeoutMs ?? 10_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket connection failed'));
      });
    });
    return new CdpSession(ws, { targetId: meta.targetId ?? null, wsUrl, opts });
  }

  onMessage(handler: (raw: string) => void): void {
    this.messageHandlers.add(handler);
  }

  offMessage(handler: (raw: string) => void): void {
    this.messageHandlers.delete(handler);
  }

  close(): void {
    try {
      this.ws.removeEventListener('message', this.wsMessageBridge);
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  sendRaw(payload: string): void {
    this.ws.send(payload);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    const limit = timeoutMs ?? this.commandTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.offMessage(handler);
        reject(new Error(`CDP ${method} timeout`));
      }, limit);

      const handler = (raw: string) => {
        try {
          const msg = JSON.parse(raw) as CdpMessage;
          if (msg.id !== id) return;
          this.offMessage(handler);
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error.message ?? `CDP ${method} error`));
          else resolve(msg.result);
        } catch {
          /* ignore parse errors */
        }
      };

      this.onMessage(handler);
      this.sendRaw(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const limit = timeoutMs ?? this.evaluateTimeoutMs;
    const result = (await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      limit,
    )) as { result?: { value?: T } } | undefined;
    return (result?.result?.value ?? null) as T;
  }

  async bringToFront(): Promise<void> {
    await this.send('Page.bringToFront', {}, 5_000);
  }

  waitForEvent(eventName: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.offMessage(handler);
        reject(new Error(`Timeout waiting for ${eventName}`));
      }, timeoutMs);

      const handler = (raw: string) => {
        try {
          const msg = JSON.parse(raw) as CdpMessage;
          if (msg.method === eventName && msg.params) {
            this.offMessage(handler);
            clearTimeout(timer);
            resolve(msg.params);
          }
        } catch {
          /* ignore */
        }
      };

      this.onMessage(handler);
    });
  }
}

export type AttachResult = {
  session: CdpSession;
  target: CdpTarget | null;
};