import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildVoyagerPeopleSearch, pickBestPeopleMatch, searchPeople } from '../src/actions/people-search.js';
import { classifyConnectabilityProbe, probeConnectability } from '../src/actions/connectability.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/people-search.json', import.meta.url), 'utf8'));

describe('people search', () => {
  it('builds voyager endpoint', () => {
    assert.match(buildVoyagerPeopleSearch('jane doe', 'csrf'), /search\/dash\/clusters/);
  });

  it('picks hint match with name tokens', () => {
    const hits = fixture.hits as Array<{ slug: string; name: string; headline: string; degree: string; profileUrl: string }>;
    const best = pickBestPeopleMatch(hits, { expectedName: 'Jane Doe', hint: 'Example' });
    assert.equal(best?.slug, 'jane-doe');
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
  });

  it('probe uses profile actions offline', async () => {
    const r = await probeConnectability({
      slug: 'jane-doe',
      expectedName: 'Jane Doe',
      profileActions: fixture.connectPrimary,
    });
    assert.equal(r.state, 'connect');
  });

  it('dry run does not need session', async () => {
    const r = await probeConnectability({ slug: 'jane-doe', live: false });
    assert.equal(r.state, 'connect');
    assert.equal(r.detail.dryRun, true);
  });
});