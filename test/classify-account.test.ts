import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyInviteResponse, recipientDialogMatches } from '../src/actions/classify-invite.js';
import { parseRelationshipsIntercept } from '../src/actions/invite.js';
import { checkAccountGuard } from '../src/session/account-guard.js';
import { editorTextFromDom } from '../src/actions/comment.js';
import { RollingWindowRateLimiter } from '../src/pacing.js';

describe('classifyInviteResponse', () => {
  it('detects limit and resend codes', () => {
    assert.equal(classifyInviteResponse(429, { data: { code: 'FUSE_LIMIT_EXCEEDED', status: 429 } }).result, 'rejected_limit');
    assert.equal(classifyInviteResponse(400, { data: { code: 'CANT_RESEND_YET', status: 400 } }).result, 'rejected_resend');
  });

  it('detects sent invitation', () => {
    const body = {
      status: 200,
      data: {
        status: 200,
        value: { invitationUrn: 'urn:li:fsd_invitation:EXAMPLE' },
      },
    };
    assert.equal(classifyInviteResponse(200, body).result, 'sent');
  });
});

describe('recipientDialogMatches', () => {
  it('matches personalize dialog text', () => {
    const dialog = 'Personalize your invitation to Jane Doe by adding a note.';
    assert.equal(recipientDialogMatches('Jane Doe', dialog), true);
  });
});

describe('parseRelationshipsIntercept', () => {
  it('fails on name mismatch', () => {
    const r = parseRelationshipsIntercept(
      200,
      JSON.stringify({ status: 200, data: { status: 200, value: { invitationUrn: 'urn:li:fsd_invitation:X' } } }),
      'Personalize your invitation to Someone Else by adding a note.',
      'Jane Doe',
    );
    assert.equal(r.status, 'recipient_name_mismatch');
  });
});

describe('checkAccountGuard', () => {
  it('rejects slug mismatch', () => {
    const r = checkAccountGuard(
      { publicIdentifier: 'jane-doe-123', profileUrn: 'urn:li:fsd_profile:EXAMPLE', name: 'Jane' },
      { publicIdentifier: 'other-slug' },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'slug_mismatch');
  });
});

describe('editorTextFromDom', () => {
  it('reads nested text nodes with paragraph breaks', () => {
    type MockNode = {
      nodeType: number;
      nodeName: string;
      textContent?: string;
      childNodes: MockNode[];
      classList?: { contains: (c: string) => boolean };
    };
    const text = (t: string): MockNode => ({ nodeType: 3, nodeName: '#text', textContent: t, childNodes: [] });
    const el = (name: string, kids: MockNode[]): MockNode => ({
      nodeType: 1,
      nodeName: name,
      childNodes: kids,
      classList: { contains: () => false },
    });
    const editor = el('DIV', [el('P', [text('line one')]), el('P', [text('line two')])]);
    assert.equal(editorTextFromDom(editor), 'line one\nline two');
  });
});

describe('RollingWindowRateLimiter', () => {
  it('blocks when over cap', () => {
    const limiter = new RollingWindowRateLimiter({ windowMs: 10_000, maxActions: 2 });
    limiter.record(1_000);
    limiter.record(2_000);
    assert.equal(limiter.canProceed(3_000), false);
  });
});