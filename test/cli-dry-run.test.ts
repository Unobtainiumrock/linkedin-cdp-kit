import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('messaging ingest queues a draft and does not send', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcdp-cli-ingest-'));
    const conversations = join(dir, 'conversations.json');
    writeFileSync(
      conversations,
      JSON.stringify([
        {
          conversationUrn: 'urn:li:msg_conversation:EXAMPLE',
          participants: [{ name: 'Jane Example', profileUrn: '', headline: '' }],
          lastActivityAt: null,
          createdAt: null,
          unreadCount: 1,
          read: false,
          title: '',
          lastMessagePreview: 'What is the price?',
          messages: [{ sender: 'Jane Example', text: 'What is the price?', subject: '', timestamp: '1' }],
        },
      ]),
    );
    const r = spawnSync(
      'node',
      ['--import', 'tsx', bin, 'messaging', 'ingest', '--state-dir', dir, '--conversations', conversations, '--self', 'Example User'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout) as { drafted: number; sent: boolean; dryRun: boolean };
    assert.equal(summary.drafted, 1);
    assert.equal(summary.sent, false);
    assert.equal(summary.dryRun, true);
    const saved = JSON.parse(readFileSync(join(dir, 'message-drafts.json'), 'utf8')) as {
      drafts: Array<{ status: string }>;
    };
    assert.equal(saved.drafts[0]?.status, 'pending');
  });

  it('comments run without --live', () => {
    const r = spawnSync('node', ['--import', 'tsx', bin, 'comments', 'run', '--state-dir', '/tmp/lcdp-dry-comments'], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dryRun/);
  });
});