import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CdpSession } from '../src/cdp/session.js';
import { focusForInput } from '../src/actions/cdp-util.js';
import { pullThread, resolveDateHeading, resolveThreadTimestamp } from '../src/actions/scrape-thread.js';

const NOW = new Date(2026, 10, 24, 15, 0, 0);

describe('resolveDateHeading', () => {
  it('resolves today, yesterday, weekdays, and month-day headings', () => {
    assert.equal(resolveDateHeading('Today', NOW), '2026-11-24');
    assert.equal(resolveDateHeading('Yesterday', NOW), '2026-11-23');
    assert.equal(resolveDateHeading('Monday', NOW), '2026-11-23');
    assert.equal(resolveDateHeading('Tuesday', NOW), '2026-11-17');
    assert.equal(resolveDateHeading('Mar 5', NOW), '2026-03-05');
    assert.equal(resolveDateHeading('December 1', NOW), '2025-12-01');
    assert.equal(resolveDateHeading('not a date', NOW), null);
  });
});

describe('pullThread scripted CDP', () => {
  it('scrolls upward with jitter and resolves headings', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const cdp = {
      send: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        return {};
      },
    } as unknown as CdpSession;
    const evaluate = async (expression: string): Promise<unknown> => {
      if (expression.includes('msg-s-message-list-content')) {
        return JSON.stringify([
          {
            sender: 'Jane Example',
            text: 'Hello from the thread',
            subject: '',
            dateHeading: 'Today',
            time: '9:04 AM',
          },
        ]);
      }
      if (expression.includes('getBoundingClientRect')) {
        return JSON.stringify({ x: 100, y: 200, width: 400, height: 500 });
      }
      if (expression.includes('.length')) return 3;
      return null;
    };
    const messages = await pullThread(
      { cdp, evaluate },
      'urn:li:msg_conversation:(urn:li:fsd_profile:EXAMPLE,2-thread)',
      { random: () => 0, sleep: async () => {}, stableRounds: 2, now: NOW, maxIterations: 5 },
    );
    assert.ok(messages);
    assert.equal(messages[0]?.sender, 'Jane Example');
    assert.equal(messages[0]?.text, 'Hello from the thread');
    assert.equal(
      messages[0]?.timestamp,
      resolveThreadTimestamp({ dateHeading: 'Today', time: '9:04 AM' }, NOW),
    );
    const nav = calls.find((call) => call.method === 'Page.navigate');
    assert.match(String(nav?.params?.['url']), /\/messaging\/thread\/2-thread\//);
    assert.ok(calls.some((call) => call.method === 'Page.bringToFront'));
    assert.ok(calls.some((call) => call.method === 'Emulation.setFocusEmulationEnabled' && call.params?.['enabled'] === true));
    const wheels = calls.filter(
      (call) => call.method === 'Input.dispatchMouseEvent' && call.params?.['type'] === 'mouseWheel',
    );
    assert.ok(wheels.length >= 1);
    const deltaY = Number(wheels[0]?.params?.['deltaY']);
    assert.ok(deltaY <= -650 && deltaY >= -1050);
    const x = Number(wheels[0]?.params?.['x']);
    const y = Number(wheels[0]?.params?.['y']);
    assert.ok(x > 100 && x < 500);
    assert.ok(y > 200 && y < 700);
  });
});

describe('focus emulation', () => {
  it('continues when the target does not support it', async () => {
    const methods: string[] = [];
    const cdp = {
      send: async (method: string) => {
        methods.push(method);
        if (method.startsWith('Emulation.')) throw new Error("Emulation.setFocusEmulationEnabled wasn't found");
        return {};
      },
    } as unknown as CdpSession;
    await focusForInput(cdp);
    assert.deepEqual(methods, ['Page.bringToFront', 'Emulation.setFocusEmulationEnabled']);
  });
});
