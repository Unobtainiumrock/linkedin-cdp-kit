import { EventEmitter } from 'node:events';
import { parseLinkedInFrame, type ParsedRealtimeMessage } from '../parse/frame.js';
import type { CdpSession } from '../cdp/session.js';

export type InboundMessage = ParsedRealtimeMessage & { receivedAt: string };

export class LinkedInMessageListener extends EventEmitter {
  private session: CdpSession | null = null;
  private handler: ((raw: string) => void) | null = null;
  private running = false;
  messageCount = 0;

  constructor(private readonly opts: { emitRawFrames?: boolean } = {}) {
    super();
  }

  async start(session: CdpSession): Promise<void> {
    if (this.running) return;
    this.session = session;
    await session.send('Network.enable', {}, 10_000);
    this.running = true;
    this.emit('connected');

    this.handler = (raw: string) => {
      try {
        const msg = JSON.parse(raw) as { method?: string; params?: { response?: { payloadData?: string } } };
        if (msg.method !== 'Network.webSocketFrameReceived') return;
        const payload = msg.params?.response?.payloadData;
        if (!payload) return;
        if (this.opts.emitRawFrames) this.emit('frame', payload);
        const parsed = parseLinkedInFrame(payload);
        if (!parsed) return;
        this.messageCount++;
        const enriched: InboundMessage = { ...parsed, receivedAt: new Date().toISOString() };
        this.emit('message', enriched);
      } catch (err) {
        this.emit('error', err);
      }
    };

    session.onMessage(this.handler);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.session && this.handler) {
      this.session.offMessage(this.handler);
    }
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    this.emit('close');
  }
}