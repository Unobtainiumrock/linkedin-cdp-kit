import type { CdpSession } from '../cdp/session.js';
import { navigate, sleep } from './cdp-util.js';
import type { ActionSession, DomSendResult, SendMessageOpts } from './types.js';

export function threadIdFromUrn(conversationUrn: string): string {
  const match = conversationUrn.match(/,([^)]+)\)$/);
  if (match?.[1]) return match[1];
  return conversationUrn.split(':').pop() || conversationUrn;
}

export type SendMessageResult =
  | { ok: true; verified: boolean; conversationUrn: string; threadId?: string }
  | { ok: false; reason: string; conversationUrn?: string };

async function detectAuthWall(evaluate: ActionSession['evaluate']): Promise<{ authwall: boolean; url?: string }> {
  const url = await evaluate('window.location.href');
  if (typeof url === 'string') {
    const lowered = url.toLowerCase();
    const patterns = ['/checkpoint/', '/login', '/authwall', '/uas/login'];
    if (patterns.some((p) => lowered.includes(p))) return { authwall: true, url };
  }
  return { authwall: false, url: typeof url === 'string' ? url : undefined };
}

async function waitForCompose(evaluate: ActionSession['evaluate'], timeoutMs = 15_000): Promise<string> {
  const expr = `
    (async () => {
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline) {
        const box = document.querySelector('.msg-form__contenteditable');
        const send = document.querySelector('.msg-form__send-button');
        if (box && send) return "ready";
        await new Promise(r => setTimeout(r, 500));
      }
      return "timeout";
    })()
  `;
  const v = await evaluate(expr, timeoutMs + 5_000);
  return String(v ?? 'timeout');
}

async function focusAndType(
  evaluate: ActionSession['evaluate'],
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  const payload = JSON.stringify(text);
  const raw = await evaluate(
    `(async () => {
      const box = document.querySelector('.msg-form__contenteditable');
      if (!box) return JSON.stringify({ ok: false, reason: "no_compose_box" });
      box.focus(); box.click();
      await new Promise(r => setTimeout(r, 150));
      const raw = ${payload};
      const paragraphs = raw.split(/\\r?\\n/);
      box.innerHTML = "";
      for (const line of paragraphs) {
        const p = document.createElement('p');
        p.textContent = line;
        box.appendChild(p);
      }
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: raw }));
      await new Promise(r => setTimeout(r, 250));
      const observed = box.textContent || "";
      const strip = (s) => s.replace(/\\s+/g, "");
      const stripObs = strip(observed);
      const stripExp = strip(raw).slice(0, Math.min(40, strip(raw).length));
      return JSON.stringify({
        ok: stripObs.length > 0 && stripExp.length > 0 && stripObs.includes(stripExp),
        reason: stripObs.includes(stripExp) ? undefined : "type_mismatch",
      });
    })()`,
    15_000,
  );
  return JSON.parse(String(raw)) as { ok: boolean; reason?: string };
}

async function clickSend(evaluate: ActionSession['evaluate']): Promise<{ ok: boolean; reason?: string }> {
  const raw = await evaluate(
    `(async () => {
      const btn = document.querySelector('.msg-form__send-button');
      if (!btn) return JSON.stringify({ ok: false, reason: "no_send_button" });
      if (btn.disabled) return JSON.stringify({ ok: false, reason: "send_button_disabled" });
      btn.scrollIntoView({ block: "center" });
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      return JSON.stringify({ ok: true });
    })()`,
    15_000,
  );
  return JSON.parse(String(raw)) as { ok: boolean; reason?: string };
}

async function verifyLastMessage(
  evaluate: ActionSession['evaluate'],
  userName: string,
  expectedText: string,
  timeoutMs = 12_000,
): Promise<{ verified: boolean }> {
  const payload = JSON.stringify({ userName, expectedText });
  const raw = await evaluate(
    `(async () => {
      const { userName, expectedText } = ${payload};
      const snippet = (expectedText || "").replace(/\\s+/g, " ").trim().slice(0, 40);
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline) {
        const items = Array.from(document.querySelectorAll('li.msg-s-message-list__event'));
        const recent = items.slice(-6);
        for (let i = recent.length - 1; i >= 0; i--) {
          const li = recent[i];
          const nameEl = li.querySelector('.msg-s-message-group__name');
          const bodyEl = li.querySelector('.msg-s-event-listitem__body');
          if (!bodyEl) continue;
          const text = (bodyEl.textContent || "").replace(/\\s+/g, " ").trim();
          const sender = nameEl ? nameEl.textContent.trim() : "";
          if (sender && userName && sender.toLowerCase().includes(userName.toLowerCase().split(" ")[0])) {
            if (!snippet || text.includes(snippet)) return JSON.stringify({ verified: true });
          }
          if (!snippet || text.includes(snippet)) return JSON.stringify({ verified: true });
        }
        await new Promise(r => setTimeout(r, 700));
      }
      return JSON.stringify({ verified: false });
    })()`,
    timeoutMs + 5_000,
  );
  return JSON.parse(String(raw)) as { verified: boolean };
}

async function voyagerSend(
  evaluate: ActionSession['evaluate'],
  csrfToken: string,
  conversationUrn: string,
  mailboxUrn: string,
  text: string,
): Promise<{ ok: boolean; status?: number }> {
  const body = {
    message: {
      body: { text, attributes: [] },
      renderContentUnions: [],
      conversationUrn,
      originToken: crypto.randomUUID(),
    },
    mailboxUrn,
    trackingId: Math.random().toString(36).slice(2, 12),
  };
  const payload = JSON.stringify({ body, csrfToken });
  const raw = await evaluate(
    `(async () => {
      try {
        const { body, csrfToken } = ${payload};
        const resp = await fetch("/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage", {
          method: "POST",
          headers: {
            "csrf-token": csrfToken,
            "accept": "application/vnd.linkedin.normalized+json+2.1",
            "content-type": "application/json; charset=UTF-8",
            "x-restli-protocol-version": "2.0.0",
          },
          credentials: "include",
          body: JSON.stringify(body),
        });
        return JSON.stringify({ ok: resp.ok, status: resp.status });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    })()`,
    15_000,
  );
  return JSON.parse(String(raw)) as { ok: boolean; status?: number };
}

export async function sendMessageLive(
  session: ActionSession,
  conversationUrn: string,
  text: string,
  opts: SendMessageOpts = {},
): Promise<DomSendResult> {
  if (!opts.live) {
    return { ok: false, reason: 'dry_run', conversationUrn, threadId: threadIdFromUrn(conversationUrn) };
  }
  if (!text.trim()) return { ok: false, reason: 'empty_text', conversationUrn };

  const threadId = threadIdFromUrn(conversationUrn);
  const userName = session.displayName || 'Me';
  const mode = opts.mode ?? 'auto';
  type SendBuild = {
    ok: boolean;
    reason: string;
    conversationUrn: string;
    threadId: string;
    verified: boolean;
    attempts: Array<Record<string, unknown>>;
    authwall: boolean;
    modeUsed: string | null;
  };
  const result: SendBuild = {
    ok: false,
    reason: 'unknown',
    conversationUrn,
    threadId,
    verified: false,
    attempts: [],
    authwall: false,
    modeUsed: null,
  };

  const auth = await detectAuthWall(session.evaluate);
  if (auth.authwall) {
    result.authwall = true;
    result.reason = 'login_or_authwall_detected';
    result.attempts.push({ step: 'auth_check', ...auth });
    return { ok: false, reason: result.reason, conversationUrn, threadId, attempts: result.attempts, authwall: true };
  }

  const tryDom = mode === 'dom' || mode === 'auto';
  const tryVoyager = (mode === 'voyager' || mode === 'auto') && opts.allowVoyagerFallback === true;

  if (tryDom) {
    try {
      await navigate(session.cdp, `https://www.linkedin.com/messaging/thread/${threadId}/`);
      const ready = await waitForCompose(session.evaluate);
      result.attempts.push({ step: 'wait_compose', status: ready });
      if (ready !== 'ready') {
        return {
          ok: false,
          reason: 'compose_box_not_ready',
          conversationUrn,
          threadId,
          attempts: result.attempts,
        };
      }
      const typed = await focusAndType(session.evaluate, text);
      result.attempts.push({ step: 'type', ...typed });
      if (!typed.ok) {
        return {
          ok: false,
          reason: typed.reason || 'type_failed',
          conversationUrn,
          threadId,
          attempts: result.attempts,
        };
      }
      const clicked = await clickSend(session.evaluate);
      result.attempts.push({ step: 'click_send', ...clicked });
      if (!clicked.ok) {
        return {
          ok: false,
          reason: clicked.reason || 'click_send_failed',
          conversationUrn,
          threadId,
          attempts: result.attempts,
        };
      }
      await sleep(1_500);
      const verified = await verifyLastMessage(session.evaluate, userName, text);
      result.attempts.push({ step: 'verify', ...verified });
      return {
        ok: true,
        verified: Boolean(verified.verified),
        conversationUrn,
        threadId,
        reason: verified.verified ? undefined : 'unverified_but_clicked',
        modeUsed: 'dom',
        attempts: result.attempts,
      };
    } catch (err) {
      result.attempts.push({ step: 'dom_error', error: err instanceof Error ? err.message : String(err) });
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'dom_failed',
        conversationUrn,
        threadId,
        attempts: result.attempts,
      };
    }
  }

  if (tryVoyager && session.csrfToken && session.mailboxUrn) {
    const resp = await voyagerSend(session.evaluate, session.csrfToken, conversationUrn, session.mailboxUrn, text);
    result.attempts.push({ step: 'voyager_post', ...resp });
    if (resp.ok) {
      const verified = await verifyLastMessage(session.evaluate, userName, text, 8_000);
      return {
        ok: true,
        verified: Boolean(verified.verified),
        conversationUrn,
        threadId,
        modeUsed: 'voyager',
        attempts: result.attempts,
      };
    }
    return {
      ok: false,
      reason: `voyager_http_${resp.status ?? 'error'}`,
      conversationUrn,
      threadId,
      attempts: result.attempts,
    };
  }

  return {
    ok: false,
    reason: result.reason === 'unknown' ? 'compose_box_not_ready' : result.reason,
    conversationUrn,
    threadId,
    attempts: result.attempts,
  };
}

/** @deprecated Use sendMessageLive via LinkedInActions */
export async function sendMessage(
  _session: unknown,
  conversationUrn: string,
  text: string,
  opts: SendMessageOpts = {},
): Promise<SendMessageResult> {
  if (!opts.live) return { ok: false, reason: 'dry_run', conversationUrn };
  return { ok: false, reason: 'use_sendMessageLive_with_ActionSession', conversationUrn };
}