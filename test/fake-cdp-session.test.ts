import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LinkedInSession } from '../src/session.js';
import type { BrowserProvider } from '../src/cdp/browser-provider.js';
import type { CdpSession } from '../src/cdp/session.js';

const ME_FIXTURE = JSON.stringify({
  included: [
    {
      $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
      firstName: 'Jane',
      lastName: 'Doe',
      publicIdentifier: 'jane-doe-123',
      entityUrn: 'urn:li:fsd_profile:EXAMPLE',
    },
  ],
});

function mockSession(): CdpSession {
  return {
    evaluate: async (expr: string) => {
      if (expr.includes('JSESSIONID')) return 'ajax:csrf-token-example';
      if (expr.includes('/voyager/api/me')) return ME_FIXTURE;
      return null;
    },
    send: async () => ({}),
    bringToFront: async () => {},
    close: () => {},
    onMessage: () => {},
    offMessage: () => {},
    targetId: 'mock',
    wsUrl: 'ws://127.0.0.1/mock',
  } as unknown as CdpSession;
}

class MockBrowserProvider implements BrowserProvider {
  async acquire() {
    return {
      cdpBase: 'http://127.0.0.1:9',
      session: mockSession(),
      targetId: 'mock',
      closeTab: async () => true,
    };
  }
}

describe('LinkedInSession with mock browser', () => {
  it('connects and loads identity', async () => {
    const li = new LinkedInSession();
    await li.connect({ cdpUrl: 'http://127.0.0.1:9', browser: new MockBrowserProvider() });
    assert.equal(li.me?.publicIdentifier, 'jane-doe-123');
    await li.close();
  });

  it('rejects identity mismatch', async () => {
    const li = new LinkedInSession();
    await assert.rejects(
      () =>
        li.connect({
          cdpUrl: 'http://127.0.0.1:9',
          browser: new MockBrowserProvider(),
          expectedAccount: { publicIdentifier: 'wrong-slug' },
        }),
      /account guard/,
    );
  });
});