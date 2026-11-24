import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const bin = join(process.cwd(), 'bin/linkedin-cdp.ts');

describe('CLI dry-run default', () => {
  it('invites run without --live', () => {
    const r = spawnSync('node', ['--import', 'tsx', bin, 'invites', 'run', '--state-dir', '/tmp/lcdp-dry-invites'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dry_run|"dryRun"/i);
  });

  it('comments run without --live', () => {
    const r = spawnSync('node', ['--import', 'tsx', bin, 'comments', 'run', '--state-dir', '/tmp/lcdp-dry-comments'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dryRun/);
  });
});