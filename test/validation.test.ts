import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertCount, assertPaginationToken, assertProfileUrn } from '../src/voyager/validation.js';
import { buildFetchProfileUpdates } from '../src/voyager/builders.js';

describe('injection guards', () => {
  it('rejects malformed profile urns', () => {
    const inject = 'urn:li:fsd_profile:A");fetch("//evil");//';
    assert.throws(() => assertProfileUrn(inject), TypeError);
    assert.throws(() => buildFetchProfileUpdates('csrf', inject), TypeError);
  });

  it('validates count and pagination token', () => {
    const urn = 'urn:li:fsd_profile:EXAMPLE';
    assert.throws(() => buildFetchProfileUpdates('csrf', urn, { count: 999_999 }), TypeError);
    assert.throws(() => buildFetchProfileUpdates('csrf', urn, { paginationToken: '");evil();//' }), TypeError);
    assert.equal(assertPaginationToken('YWJj'), 'YWJj');
    assert.equal(assertPaginationToken(null), null);
    assert.equal(assertCount('n', 5, { min: 1, max: 10 }), 5);
  });
});