import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CdpSession } from '../src/cdp/session.js';
import {
  connectionCardFromText,
  scrapeConnections,
  type ScrapedConnection,
} from '../src/actions/scrape-connections.js';

type Call = { method: string; params?: Record<string, unknown> };

function scriptedScrape(anchors: number[], people: ScrapedConnection[]) {
  const calls: Call[] = [];
  let seenAnchors = 0;
  const cdp = {
    send: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    },
  } as unknown as CdpSession;
  const evaluate = async (expression: string): Promise<unknown> => {
    calls.push({ method: 'Runtime.evaluate', params: { expression } });
    if (expression.includes('headline')) return { count: people.length, people };
    if (expression.includes('show more results')) return false;
    if (expression.includes('.length')) {
      const value = anchors[Math.min(seenAnchors, anchors.length - 1)] ?? 0;
      seenAnchors += 1;
      return value;
    }
    return null;
  };
  return { session: { cdp, evaluate }, calls };
}

describe('connection card extraction', () => {
  it('keeps slug, name, headline, and connected', () => {
    const card = connectionCardFromText(
      'jane-example',
      'Jane Example • 2nd',
      'Jane Example • 2nd\nEngineer\nConnected on January 2\nMessage',
    );
    assert.deepEqual(card, {
      slug: 'jane-example',
      name: 'Jane Example',
      headline: 'Engineer',
      connected: 'Connected on January 2',
      profileUrl: 'https://www.linkedin.com/in/jane-example/',
    });
  });
});

describe('scrapeConnections scripted CDP', () => {
  const people: ScrapedConnection[] = [
    {
      slug: 'jane-example',
      name: 'Jane Example',
      headline: 'Engineer',
      connected: 'Connected on January 2',
      profileUrl: 'https://www.linkedin.com/in/jane-example/',
    },
  ];

  it('scrolls with jitter, show-more, and periodic bringToFront', async () => {
    const fake = scriptedScrape([2, 2, 2, 2, 2, 2, 2], people);
    const result = await scrapeConnections({
      live: true,
      session: fake.session,
      anchorCap: 50,
      wallClockCapMs: 60_000,
      random: () => 0,
      sleep: async () => {},
      now: () => 0,
    });
    assert.equal(result.status, 'complete');
    if (result.status === 'dry_run') return;
    assert.deepEqual(result.connections, people);
    const fronts = fake.calls.filter((call) => call.method === 'Page.bringToFront');
    assert.ok(fronts.length >= 2);
    const wheels = fake.calls.filter(
      (call) => call.method === 'Input.dispatchMouseEvent' && call.params?.['type'] === 'mouseWheel',
    );
    assert.ok(wheels.length >= 1);
    assert.equal(wheels[0]?.params?.['deltaY'], 1200);
    assert.equal(wheels[0]?.params?.['x'], 380);
    assert.ok(
      fake.calls.some(
        (call) =>
          call.method === 'Input.dispatchMouseEvent' && call.params?.['type'] === 'mouseMoved',
      ),
    );
    assert.ok(
      fake.calls.some(
        (call) =>
          call.method === 'Runtime.evaluate' &&
          String(call.params?.['expression']).includes('show more results'),
      ),
    );
  });

  it('stops before scrolling when the wall clock is already spent', async () => {
    const fake = scriptedScrape([1], people);
    const result = await scrapeConnections({
      live: true,
      session: fake.session,
      wallClockCapMs: 0,
      random: () => 0,
      sleep: async () => {},
      now: () => 5_000,
    });
    assert.equal(result.status, 'manual_review');
    if (result.status === 'dry_run') return;
    assert.equal(result.reason, 'wall_clock');
    assert.equal(
      fake.calls.some((call) => call.method === 'Input.dispatchMouseEvent'),
      false,
    );
    assert.ok(fake.calls.some((call) => call.method === 'Page.bringToFront'));
  });

  it('caps when the anchor count reaches the limit', async () => {
    const fake = scriptedScrape([4], people);
    const result = await scrapeConnections({
      live: true,
      session: fake.session,
      anchorCap: 3,
      wallClockCapMs: 60_000,
      random: () => 0.9,
      sleep: async () => {},
      now: () => 0,
    });
    assert.equal(result.status, 'capped');
  });
});
