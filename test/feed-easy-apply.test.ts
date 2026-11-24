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

  it('react does not call a guessed voyager url when the flag is on', async () => {
    const exprs: string[] = [];
    const session = feedSession(async (expr) => {
      exprs.push(expr);
      return { ok: true, pressed: true };
    });
    const r = await reactToPost({
      activityUrn: 'urn:li:activity:1',
      live: true,
      session,
      useVoyagerFallback: true,
    });
    assert.equal(r.status, 'reacted');
    assert.equal(exprs.some((expr) => /voyagerSocialDash|reactOnEntity|feedComments|voyagerFeed/.test(expr)), false);
  });

  it('share stays uncertain when the composer is missing', async () => {
    const session = feedSession(async (expr) => {
      if (expr.includes('contenteditable')) return { ok: false };
      return { ok: true, dialogOpen: true };
    });
    const r = await sharePost({ activityUrn: 'urn:li:activity:1', text: 'Hello', live: true, session });
    assert.equal(r.status, 'manual_review');
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
    assert.ok(EASY_APPLY_SELECTORS.captchaIframe.includes('funcaptcha'));
    assert.ok(EASY_APPLY_SELECTORS.resumeThumbnail.includes('resume-btn'));
  });

  it('dry-run does not click Submit, Save and exit, Dismiss, or a resume thumbnail', async () => {
    const clicks: string[] = [];
    const session = feedSession(async (expr) => {
      if (expr.includes('btn.click()')) clicks.push(expr);
      if (expr.includes('blocked')) return { blocked: false };
      if (expr.includes('Easy Apply to')) return { ok: true };
      if (expr.includes("button[aria-label='Submit application']") && expr.includes('isSubmit')) {
        return { ok: true, selector: "button[aria-label='Submit application']", isSubmit: true };
      }
      return { ok: false, reason: 'no_advance' };
    });
    const r = await easyApplyToJob({
      jobUrl: 'https://www.linkedin.com/jobs/view/123/',
      live: true,
      dryRun: true,
      session,
    });
    assert.equal(r.status, 'review_reached');
    assert.equal(clicks.some((expr) => expr.includes("button[aria-label='Submit application']") && expr.includes('btn.click()')), false);
    assert.equal(clicks.some((expr) => expr.includes('Save and exit') && expr.includes('querySelector(sel)')), false);
  });

  it('uploads through the file input and stops without a pdf', async () => {
    const sends: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    const base = feedSession(async (expr) => {
      if (expr.includes('blocked')) return { blocked: false };
      if (expr.includes("input[name='file']")) return true;
      if (expr.includes('Easy Apply to')) return { ok: true };
      return { ok: false, reason: 'no_advance' };
    });
    const session = {
      ...base,
      cdp: {
        ...base.cdp,
        send: async (method: string, params?: Record<string, unknown>) => {
          sends.push({ method, params });
          if (method === 'DOM.getDocument') return { root: { nodeId: 7 } };
          if (method === 'DOM.querySelector') return { nodeId: 42 };
          return {};
        },
      },
    } as ActionSession;
    const missing = await easyApplyToJob({
      jobUrl: 'https://www.linkedin.com/jobs/view/123/',
      live: true,
      dryRun: true,
      session,
    });
    assert.equal(missing.status, 'gated');
    if (missing.status === 'gated') assert.equal(missing.gate, 'no_resume_pdf');
    sends.length = 0;
    const uploaded = await easyApplyToJob({
      jobUrl: 'https://www.linkedin.com/jobs/view/123/',
      live: true,
      dryRun: true,
      resumePdfPath: '/tmp/example-resume.pdf',
      session,
    });
    assert.notEqual(uploaded.status, 'submitted');
    const fileCall = sends.find((call) => call.method === 'DOM.setFileInputFiles');
    assert.equal(fileCall?.params?.['nodeId'], 42);
    assert.deepEqual(fileCall?.params?.['files'], ['/tmp/example-resume.pdf']);
    assert.equal(sends.some((call) => call.params?.['nodeId'] === 1), false);
  });
});