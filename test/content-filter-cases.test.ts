import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { contentRefusal, type ContentFilterViolation } from '../src/automation/comments/content-filter.js';

type CaseRow = { name: string; text: string; source: string; expected: string };

const cases = JSON.parse(
  readFileSync(new URL('../fixtures/content-filter-cases.json', import.meta.url), 'utf8'),
) as CaseRow[];

function normalizeExpected(expected: string): ContentFilterViolation | 'pass' {
  if (expected === 'pass' || expected === 'ok' || expected === '') return 'pass';
  if (expected === 'mention_or_email') return 'mention';
  if (expected === 'contact_number') return 'contact_digits';
  if (expected === 'copied_from_source') return 'copied_span';
  return expected as ContentFilterViolation;
}

describe('content filter cases', () => {
  it(`runs all ${cases.length} fixture cases`, () => {
    const failures: string[] = [];
    for (const row of cases) {
      const got = contentRefusal(row.text, row.source ?? '') ?? 'pass';
      const want = normalizeExpected(row.expected);
      if (got !== want) failures.push(`${row.name}: want ${want} got ${got}`);
    }
    if (failures.length) {
      assert.fail(`${failures.length} mismatch(es)\n${failures.slice(0, 15).join('\n')}`);
    }
  });
});