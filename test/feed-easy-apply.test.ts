import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScriptedActionSession } from './support/scripted-session.js';
import { readFeed, reactToPost, sharePost } from '../src/actions/feed.js';
import { easyApplyToJob, EASY_APPLY_SELECTORS } from '../src/actions/easy-apply.js';
import type { ActionSession } from '../src/actions/types.js';

function feedSession(evaluateImpl: (expr: string) => Promise<unknown>): ActionSession {
  const base = createScriptedActionSession({});
  return { ...base, evaluate: evaluateImpl };
}

describe('feed actions scripted', () => {
  it('readFeed harvests until limit', async () => {
    let wheels = 0;
    const session = feedSession(async (expr) => {
      if (expr.includes('data-urn')) {
        return [
          { activityUrn: 'urn:li:activity:1', activityId: '1', author: 'Jane Doe', text: 'Hello' },
          { activityUrn: 'urn:li:activity:2', activityId: '2', author: 'John Example', text: 'World' },
        ];
      }
      return null;
    });
    const sessionWithCdp = {
      ...session,
      cdp: {
        ...session.cdp,
        send: async (method: string) => {
          if (method === 'Input.dispatchMouseEvent') wheels++;
          return {};
        },
      },
    };
    const r = await readFeed({ live: true, limit: 2, session: sessionWithCdp as ActionSession });
    assert.equal(r.status, 'ok');
    if (r.status === 'ok') assert.equal(r.posts.length, 2);
    assert.ok(wheels > 0);
  });

  it('react dry-run default', async () => {
    const r = await reactToPost({ activityUrn: 'urn:li:activity:1', live: false });
    assert.equal(r.status, 'dry_run');
  });

  it('react verifies pressed state when scripted', async () => {
    const session = feedSession(async () => ({ ok: true, pressed: true }));
    const r = await reactToPost({ activityUrn: 'urn:li:activity:1', live: true, session });
    assert.equal(r.status, 'reacted');
    assert.equal((r as { pressed?: boolean }).pressed, true);
  });

  it('share dry-run default', async () => {
    const r = await sharePost({ activityUrn: 'urn:li:activity:1', live: false });
    assert.equal(r.status, 'dry_run');
  });
});

describe('easy apply scripted', () => {
  it('happy path stops at review in dryRun live', async () => {
    let step = 0;
    const session = feedSession(async (expr) => {
      if (expr.includes('blocked')) return { blocked: false };
      if (expr.includes('Easy Apply')) return { ok: true };
      if (expr.includes('ADVANCE') || expr.includes('modalNext') || expr.includes('Continue to next step')) {
        step++;
        if (step >= 2) return { ok: true, selector: "button[aria-label='Review your application']", isSubmit: false };
        return { ok: true, selector: "button[aria-label='Continue to next step']", isSubmit: false };
      }
      if (expr.includes('Save and exit')) return { savePresent: true, saveClicked: false };
      return { ok: true };
    });
    const r = await easyApplyToJob({
      jobUrl: 'https://www.linkedin.com/jobs/view/123/',
      live: true,
      dryRun: true,
      session,
    });
    assert.equal(r.status, 'review_reached');
  });

  it('external apply gate', async () => {
    const session = feedSession(async () => ({ blocked: true, gate: 'external_apply' }));
    const r = await easyApplyToJob({ jobUrl: 'https://www.linkedin.com/jobs/view/123/', live: true, dryRun: true, session });
    assert.equal(r.status, 'gated');
    if (r.status === 'gated') assert.equal(r.gate, 'external_apply');
  });

  it('captcha gate', async () => {
    const session = feedSession(async (expr) => {
      if (expr.includes('blocked')) return { blocked: true, gate: 'captcha' };
      return {};
    });
    const r = await easyApplyToJob({ jobUrl: 'https://www.linkedin.com/jobs/view/123/', live: true, dryRun: true, session });
    assert.equal(r.status, 'gated');
  });

  it('selectors forbid save and exit', () => {
    assert.ok(EASY_APPLY_SELECTORS.modalSaveAndExit.includes('Save and exit'));
    assert.ok(EASY_APPLY_SELECTORS.modalDismiss.includes('Dismiss'));
  });
});