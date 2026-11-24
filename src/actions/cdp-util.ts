import type { CdpSession } from '../cdp/session.js';
import { jitteredDelay } from '../pacing.js';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type SettleRange = { minMs: number; maxMs: number };

export const NAV_SETTLE: SettleRange = { minMs: 900, maxMs: 1_800 };
export const INVITE_SETTLE: SettleRange = { minMs: 1_600, maxMs: 2_600 };
export const COMMENT_TYPE_SETTLE: SettleRange = { minMs: 200, maxMs: 450 };
export const COMMENT_POLL_SETTLE: SettleRange = { minMs: 400, maxMs: 700 };
export const SEND_VERIFY_SETTLE: SettleRange = { minMs: 1_100, maxMs: 1_900 };

export function settleDelay(range: SettleRange): Promise<void> {
  return jitteredDelay(range.minMs, range.maxMs);
}

export function actionSleep(ms: number): Promise<void> {
  return sleep(process.env['LINKEDIN_CDP_FAST_NAV'] === '1' ? 0 : ms);
}

export async function enablePage(session: CdpSession): Promise<void> {
  await session.send('Page.enable', {}, 5_000);
}

export async function navigate(session: CdpSession, url: string): Promise<void> {
  await enablePage(session);
  await session.send('Page.navigate', { url }, 15_000);
  if (typeof session.waitForEvent === 'function') {
    try {
      await session.waitForEvent('Page.loadEventFired', 30_000);
    } catch {
      /* slow loads */
    }
  }
  await settleDelay(NAV_SETTLE);
}

export async function bringToFront(session: CdpSession): Promise<void> {
  await session.bringToFront();
}

export async function focusForInput(session: CdpSession): Promise<void> {
  try {
    await session.send('Page.bringToFront', {}, 5_000);
  } catch {
    /* A lost foreground tab must not abort the action. */
  }
  try {
    if (typeof session.setFocusEmulation === 'function') await session.setFocusEmulation(true);
    else await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }, 5_000);
  } catch {
    /* Older targets omit Emulation.setFocusEmulationEnabled. */
  }
}

export async function inputInsertText(session: CdpSession, text: string): Promise<void> {
  await focusForInput(session);
  await session.send('Input.insertText', { text }, 15_000);
}

type NetworkEventParams = {
  requestId?: string;
  response?: { url?: string; status?: number };
  request?: { url?: string; method?: string; postData?: string };
};

export type CapturedNetworkResponse = {
  requestId: string;
  status: number;
  url: string;
  method: string | null;
  postData: string | null;
};

export async function awaitNetworkResponse(
  session: CdpSession,
  urlPart: string,
  during: () => Promise<void>,
  timeoutMs = 12_000,
): Promise<CapturedNetworkResponse | null> {
  await session.send('Network.enable', {}, 5_000);
  const requests = new Map<string, { method: string; url: string; postData: string | null }>();

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      if (!settled) resolve(null);
    }, timeoutMs);

    const handler = (raw: string) => {
      try {
        const msg = JSON.parse(raw) as {
          method?: string;
          params?: NetworkEventParams;
        };
        const requestId = msg.params?.requestId;
        if (!requestId) return;
        if (msg.method === 'Network.requestWillBeSent') {
          const url = msg.params?.request?.url ?? '';
          if (!url.includes(urlPart)) return;
          requests.set(requestId, {
            method: msg.params?.request?.method ?? 'GET',
            url,
            postData: msg.params?.request?.postData ?? null,
          });
          return;
        }
        if (msg.method !== 'Network.responseReceived') return;
        const url = msg.params?.response?.url ?? '';
        if (!url.includes(urlPart)) return;
        const prior = requests.get(requestId);
        if (prior && prior.method !== 'POST') return;
        const status = msg.params?.response?.status ?? 0;
        settled = true;
        cleanup();
        resolve({
          requestId,
          status,
          url,
          method: prior?.method ?? null,
          postData: prior?.postData ?? null,
        });
      } catch {
        /* ignore malformed CDP frames */
      }
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      session.offMessage(handler);
    };

    session.onMessage(handler);
    void during().catch(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(null);
      }
    });
  });
}

export async function getResponseBody(session: CdpSession, requestId: string): Promise<string> {
  const result = (await session.send('Network.getResponseBody', { requestId }, 15_000)) as {
    body?: string;
  };
  return result.body ?? '';
}

export async function getRequestPostData(session: CdpSession, requestId: string): Promise<string | null> {
  try {
    const result = (await session.send('Network.getRequestPostData', { requestId }, 15_000)) as {
      postData?: string;
    };
    return typeof result?.postData === 'string' && result.postData.length > 0 ? result.postData : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no post data|not found|unknown/i.test(message)) return null;
    throw err;
  }
}

export const SHADOW_HELPERS = `
function deepAll(pred){var out=[];function walk(root){var els=root.querySelectorAll('*');for(var i=0;i<els.length;i++){var e=els[i];try{if(pred(e))out.push(e);}catch(_){}if(e.shadowRoot)walk(e.shadowRoot);}}walk(document);return out;}
function vis(el){if(!el)return false;var b=el.getBoundingClientRect();var s=getComputedStyle(el);return b.width>0&&b.height>0&&s.visibility!='hidden'&&s.display!='none'&&s.opacity!='0';}
function aria(e){return ((e.getAttribute&&e.getAttribute('aria-label'))||'');}
function label(e){return (aria(e)||e.innerText||'').trim();}
`;