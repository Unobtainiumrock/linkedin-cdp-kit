import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makePaginationToken } from '../src/voyager/pagination.js';

const KNOWN_ACTIVITY_ID = '7442063467911548929';
const EXPECTED_TOKEN =
  'dXJuOmxpOmFjdGl2aXR5Ojc0NDIwNjM0Njc5MTE1NDg5MjktMTc3NDMyNjE5NzYwMw%3D%3D';

describe('makePaginationToken', () => {
  it('derives the pinned token from string id', () => {
    assert.equal(makePaginationToken(KNOWN_ACTIVITY_ID), EXPECTED_TOKEN);
  });

  it('accepts bigint', () => {
    assert.equal(makePaginationToken(BigInt(KNOWN_ACTIVITY_ID)), EXPECTED_TOKEN);
  });

  it('rejects Number input', () => {
    assert.throws(() => makePaginationToken(Number(KNOWN_ACTIVITY_ID)), TypeError);
  });

  it('rejects invalid ids', () => {
    for (const bad of ['', 'abc', '-5', '0']) {
      assert.throws(() => makePaginationToken(bad), TypeError);
    }
  });
});