import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildVoyagerPeopleSearch, pickBestPeopleMatch, searchPeople, type PeopleSearchHit } from '../src/actions/people-search.js';
import { CONNECTABILITY_PROBE_EXPR, classifyConnectabilityProbe, probeConnectability } from '../src/actions/connectability.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/people-search.json', import.meta.url), 'utf8'));

describe('people search', () => {
  it('builds voyager endpoint', () => {
    assert.match(buildVoyagerPeopleSearch('jane doe', 'csrf'), /search\/dash\/clusters/);
  });

  it('picks hint match with name tokens', () => {
    const hits = fixture.hits as PeopleSearchHit[];
    const best = pickBestPeopleMatch(hits, { expectedName: 'Jane Doe', hint: 'Example' });
    assert.equal(best?.slug, 'jane-doe');
  });

  it('a sidebar card cannot satisfy the name check', () => {
    const hits: PeopleSearchHit[] = [
      {
        slug: 'sidebar-card',
        name: 'Jane Doe',
        headline: 'Example engineer at Sample Co',
        degree: '2nd',
        profileUrl: 'https://www.linkedin.com/in/sidebar-card/',
        sidebar: true,
      },
      {
        slug: 'other-person',
        name: 'Other Person',
        headline: 'Example headline',
        degree: '3rd',
        profileUrl: 'https://www.linkedin.com/in/other-person/',
      },
    ];
    assert.equal(pickBestPeopleMatch(hits, { expectedName: 'Jane Doe', hint: 'Example' }), null);
    assert.equal(pickBestPeopleMatch(fixture.hits as PeopleSearchHit[], { expectedName: 'Nobody Here' }), null);
  });

  it('searches offline with voyager fixture', async () => {
    const evaluates: string[] = [];
    const session = {
      csrfToken: 'csrf',
      evaluate: async (expr: string) => {
        evaluates.push(expr);
        return readFileSync(new URL('../fixtures/voyager-people-search.json', import.meta.url), 'utf8');
      },
      cdp: {} as never,
      mailboxUrn: 'urn:li:fsd_profile:EXAMPLE',
      publicIdentifier: 'example-user',
      displayName: 'Example User',
    };
    const r = await searchPeople({ keywords: 'Jane Doe', live: true, session, hint: 'Example' });
    assert.equal(r.status, 'ok');
    if (r.status === 'ok') {
      assert.equal(r.best?.slug, 'jane-doe');
      assert.equal(r.source, 'voyager');
    }
    assert.ok(evaluates[0]?.includes('voyager/api/search'));
  });
});

describe('connectability', () => {
  it('classifies fixture probes', () => {
    assert.equal(classifyConnectabilityProbe(fixture.connectPending, { expectedName: 'Jane Doe' }), 'pending');
    assert.equal(classifyConnectabilityProbe(fixture.connectPrimary, { expectedName: 'Jane Doe' }), 'connect');
    assert.equal(classifyConnectabilityProbe(fixture.wrongTitle, { expectedName: 'Jane Doe' }), 'unavailable');
    assert.equal(
      classifyConnectabilityProbe({ title: '', hasConnectPrimary: true }, { expectedName: 'Jane Doe' }),
      'unavailable',
    );
    assert.equal(
      classifyConnectabilityProbe(
        {
          title: 'Jane Doe',
          labels: ['Invite Other Person to connect', 'Message'],
          degree: '2nd',
        },
        { expectedName: 'Jane Doe' },
      ),
      'message',
    );
  });

  it('probe never clicks an invite', () => {
    assert.match(CONNECTABILITY_PROBE_EXPR, /moreBtn\.click\(\)/);
    assert.match(CONNECTABILITY_PROBE_EXPR, /document\.body\.click\(\)/);
    assert.equal(CONNECTABILITY_PROBE_EXPR.includes('to connect").click') || CONNECTABILITY_PROBE_EXPR.includes("Connect').click"), false);
    const clicks = CONNECTABILITY_PROBE_EXPR.match(/\.click\(\)/g) ?? [];
    assert.equal(clicks.length, 2);
  });

  it('probe uses profile actions offline', async () => {
    const r = await probeConnectability({
      slug: 'jane-doe',
      expectedName: 'Jane Doe',
      profileActions: fixture.connectPrimary,
    });
    assert.equal(r.state, 'connect');
  });

  it('dry run does not need session and does not claim connect', async () => {
    const r = await probeConnectability({ slug: 'jane-doe', live: false });
    assert.equal(r.state, 'unavailable');
    assert.equal(r.detail.dryRun, true);
  });
});