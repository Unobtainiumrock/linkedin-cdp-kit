import type { ActionSession } from './types.js';
import { actionSleep, navigate, settleDelay } from './cdp-util.js';

export type EasyApplyGate = '2fa_required' | 'captcha' | 'checkpoint' | 'external_apply';

export type EasyApplyResult =
  | { status: 'dry_run'; jobUrl: string }
  | { status: 'gated'; gate: EasyApplyGate; detail?: Record<string, unknown> }
  | { status: 'review_reached' | 'submitted' | 'manual_review'; steps: number; detail?: Record<string, unknown> };

export type EasyApplyOptions = {
  jobUrl: string;
  resumePdfPath?: string;
  dryRun?: boolean;
  live?: boolean;
  session?: ActionSession;
};

const STEP_PAUSE = { minMs: 500, maxMs: 1_500 };

export const EASY_APPLY_SELECTORS = {
  modal: 'div[role="dialog"][aria-labelledby]',
  modalNext: "button[aria-label='Continue to next step']",
  modalReview: "button[aria-label='Review your application']",
  modalSubmit: "button[aria-label='Submit application']",
  modalSaveAndExit: "button[aria-label='Save and exit']",
  modalDismiss: "button[aria-label='Dismiss']",
  easyApplyEntry: "button[aria-label^='Easy Apply to']",
  externalApply: "button[aria-label^='Apply to']",
  resumeFileInput: "input[name='file'][type='file']",
  captchaIframe: "iframe[src*='captcha'], iframe[src*='arkoselabs']",
  twoFaInput: "input[name='pin']",
} as const;

const BLOCKER_EXPR = `(() => {
  const url = location.href;
  if (/\\/checkpoint\\//i.test(url)) return { blocked: true, gate: 'checkpoint' };
  if (document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.twoFaInput)})) return { blocked: true, gate: '2fa_required' };
  if (document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.captchaIframe)})) return { blocked: true, gate: 'captcha' };
  const ext = document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.externalApply)});
  const easy = document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.easyApplyEntry)});
  if (ext && !easy) return { blocked: true, gate: 'external_apply' };
  return { blocked: false };
})()`;

const ADVANCE_EXPR = `(() => {
  const modal = document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.modal)});
  if (!modal) return { ok: false, reason: 'modal_missing' };
  const forbidden = modal.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.modalSaveAndExit)}) || modal.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.modalDismiss)});
  if (forbidden && forbidden.matches(':focus-within')) return { ok: false, reason: 'forbidden_focus' };
  const order = [
    ${JSON.stringify(EASY_APPLY_SELECTORS.modalNext)},
    ${JSON.stringify(EASY_APPLY_SELECTORS.modalReview)},
    ${JSON.stringify(EASY_APPLY_SELECTORS.modalSubmit)},
  ];
  for (const sel of order) {
    const btn = modal.querySelector(sel);
    if (btn && !btn.hasAttribute('disabled')) {
      return { ok: true, selector: sel, isSubmit: sel.includes('Submit') };
    }
  }
  return { ok: false, reason: 'no_advance' };
})()`;

async function humanPause(): Promise<void> {
  if (process.env['LINKEDIN_CDP_FAST_NAV'] === '1') return;
  await settleDelay(STEP_PAUSE);
}

export async function easyApplyToJob(opts: EasyApplyOptions): Promise<EasyApplyResult> {
  const dryRun = opts.dryRun ?? true;
  if (!opts.live) return { status: 'dry_run', jobUrl: opts.jobUrl };
  const session = opts.session;
  if (!session) throw new Error('session required');

  await navigate(session.cdp, opts.jobUrl);
  await humanPause();

  const blockers = await session.evaluate(BLOCKER_EXPR);
  if (blockers && typeof blockers === 'object' && (blockers as { blocked?: boolean }).blocked) {
    return { status: 'gated', gate: (blockers as { gate: EasyApplyGate }).gate };
  }

  await session.evaluate(`(() => {
    const btn = document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.easyApplyEntry)});
    if (btn) btn.click();
    return { ok: !!btn };
  })()`);
  await humanPause();

  let steps = 0;
  for (let i = 0; i < 12; i++) {
    const gate = await session.evaluate(BLOCKER_EXPR);
    if (gate && typeof gate === 'object' && (gate as { blocked?: boolean }).blocked) {
      return { status: 'gated', gate: (gate as { gate: EasyApplyGate }).gate, detail: { steps } };
    }

    const resumeNeeded = await session.evaluate(`(() => !!document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.resumeFileInput)}))()`);
    if (resumeNeeded === true && opts.resumePdfPath) {
      await session.cdp.send('DOM.setFileInputFiles', {
        files: [opts.resumePdfPath],
        nodeId: 1,
      }).catch(() => undefined);
    }

    const next = await session.evaluate(ADVANCE_EXPR);
    const n = next as { ok?: boolean; selector?: string; isSubmit?: boolean; reason?: string };
    if (!n?.ok) break;

    const isReview = n.selector?.includes('Review');
    const isSubmit = n.isSubmit === true;

    if (isSubmit && dryRun) {
      return { status: 'review_reached', steps, detail: { stopped: 'dry_run_before_submit' } };
    }
    if (isSubmit && !dryRun) {
      await session.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.modalSubmit)}); if (b) b.click(); return { ok: !!b }; })()`);
      return { status: 'submitted', steps: steps + 1 };
    }

    await session.evaluate(`(() => {
      const modal = document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.modal)});
      const btn = modal && modal.querySelector(${JSON.stringify(n.selector ?? EASY_APPLY_SELECTORS.modalNext)});
      if (btn) btn.click();
      return { ok: !!btn, clicked: ${JSON.stringify(n.selector ?? '')} };
    })()`);
    steps += 1;
    await humanPause();

    if (isReview && dryRun) {
      return { status: 'review_reached', steps };
    }
  }

  const saveClicked = await session.evaluate(`(() => {
    const modal = document.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.modal)});
    const save = modal && modal.querySelector(${JSON.stringify(EASY_APPLY_SELECTORS.modalSaveAndExit)});
    return { savePresent: !!save, saveClicked: false };
  })()`);
  void saveClicked;

  return { status: 'manual_review', steps, detail: { reason: 'step_limit' } };
}