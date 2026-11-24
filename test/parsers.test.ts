import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProfile, parseProfileUpdates } from '../src/parse/profile.js';
import { parseConversations } from '../src/parse/messaging.js';
import { toSlug } from '../src/parse/slug.js';
import { pullProfilePosts } from '../src/voyager/profile-pull.js';

describe('parseProfile', () => {
  const fixture = {
    included: [
      {
        $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
        firstName: 'Ada',
        lastName: 'Lovelace',
        publicIdentifier: 'ada-lovelace-1234',
        entityUrn: 'urn:li:fsd_profile:EXAMPLE',
        summary: 'Builds computing machines.',
      },
      {
        $type: 'com.linkedin.voyager.dash.identity.profile.Position',
        title: 'Founder',
        companyName: 'Analytical Engine',
        dateRange: { start: { month: 1, year: 2026 } },
      },
      {
        $type: 'com.linkedin.voyager.dash.identity.profile.Position',
        title: 'Intern',
        companyName: 'Babbage Ltd',
        dateRange: { start: { month: 1, year: 2025 }, end: { month: 4, year: 2025 } },
      },
    ],
  };

  it('parses dateRange nesting', () => {
    const p = parseProfile(fixture, { expectPublicIdentifier: 'ada-lovelace-1234' });
    assert.ok(p);
    assert.equal(p.positions[0]?.dateRange?.label, 'Jan 2026 – Present');
    assert.equal(p.positions[1]?.dateRange?.current, false);
  });

  it('refuses identity mismatch', () => {
    assert.throws(() => parseProfile(fixture, { expectPublicIdentifier: 'nobody' }), /mismatch/);
  });
});

describe('parseProfileUpdates', () => {
  it('uses oldest captured post as cursor', () => {
    const raw = {
      included: [
        {
          $type: 'com.linkedin.voyager.dash.feed.Update',
          entityUrn: 'urn:li:fsd_update:(urn:li:activity:9000000000000000000,X)',
          commentary: { text: { text: 'post' } },
        },
      ],
    };
    const parsed = parseProfileUpdates(raw);
    assert.equal(parsed.lastActivityId, 9000000000000000000n);
  });
});

describe('messaging parsers', () => {
  it('parses a synthetic conversation payload', () => {
    const payload = {
      data: {
        messengerConversationsByCategoryQuery: {
          elements: [
            {
              entityUrn: 'urn:li:msg_conversation:(urn:li:fsd_profile:ME,2-thread=)',
              conversationParticipants: [
                {
                  hostIdentityUrn: 'urn:li:fsd_profile:JANE',
                  participantType: {
                    member: { firstName: { text: 'Jane' }, lastName: { text: 'Doe' } },
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const convos = parseConversations(payload);
    assert.equal(convos.length, 1);
    assert.equal(convos[0]?.participants[0]?.name, 'Jane Doe');
  });

  it('toSlug normalizes URLs', () => {
    assert.equal(toSlug('https://www.linkedin.com/in/jane-doe-123/'), 'jane-doe-123');
    assert.equal(toSlug(null), null);
  });
});

describe('pullProfilePosts partial flags', () => {
  function fakeSession(pages: string[]) {
    let i = 0;
    return {
      csrfToken: 'csrf',
      evaluate: async () => {
        const p = pages[i++];
        return p ?? JSON.stringify({ included: [] });
      },
    };
  }

  it('marks 429 as incomplete', async () => {
    const page = (text: string, id: bigint) =>
      JSON.stringify({
        included: [
          {
            $type: 'com.linkedin.voyager.dash.feed.Update',
            entityUrn: `urn:li:fsd_update:(urn:li:activity:${id},X)`,
            commentary: { text: { text } },
          },
        ],
      });
    const result = await pullProfilePosts(
      fakeSession([page('A', 9000000000000000000n), '{"error":429}']),
      'urn:li:fsd_profile:EXAMPLE',
      { delayMs: 0 },
    );
    assert.equal(result.complete, false);
    assert.match(result.error || '', /429/);
  });

  it('marks a stalled cursor incomplete and an empty page complete', async () => {
    const page = JSON.stringify({
      included: [
        {
          entityUrn: 'urn:li:activity:7442063467911548929',
          commentary: { text: { text: 'One post' } },
        },
      ],
    });
    const stalled = await pullProfilePosts(fakeSession([page, page]), 'urn:li:fsd_profile:EXAMPLE', { delayMs: 0 });
    assert.equal(stalled.complete, false);
    assert.match(stalled.error || '', /stalled/);
    assert.equal(stalled.posts.length, 1);

    const empty = JSON.stringify({ included: [] });
    const done = await pullProfilePosts(fakeSession([page, empty]), 'urn:li:fsd_profile:EXAMPLE', { delayMs: 0 });
    assert.equal(done.complete, true);
    assert.equal(done.error, null);
    assert.equal(done.posts.length, 1);
  });
});