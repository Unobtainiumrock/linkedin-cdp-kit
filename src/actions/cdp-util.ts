import type { CdpSession } from '../cdp/session.js';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  await sleep(profileSafeSleepMs());
}

function profileSafeSleepMs(): number {
  return process.env['LINKEDIN_CDP_FAST_NAV'] === '1' ? 0 : 1_500;
}

export async function bringToFront(session: CdpSession): Promise<void> {
  await session.bringToFront();
}

export async function inputInsertText(session: CdpSession, text: string): Promise<void> {
  await bringToFront(session);
  await session.send('Input.insertText', { text }, 15_000);
}

type NetworkResponse = {
  requestId?: string;
  response?: { url?: string; status?: number };
};

export async function awaitNetworkResponse(
  session: CdpSession,
  urlPart: string,
  during: () => Promise<void>,
  timeoutMs = 12_000,
): Promise<{ requestId: string; status: number; url: string } | null> {
  await session.send('Network.enable', {}, 5_000);

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
          params?: NetworkResponse;
        };
        if (msg.method !== 'Network.responseReceived') return;
        const url = msg.params?.response?.url ?? '';
        if (!url.includes(urlPart)) return;
        const requestId = msg.params?.requestId;
        const status = msg.params?.response?.status ?? 0;
        if (!requestId) return;
        settled = true;
        cleanup();
        resolve({ requestId, status, url });
      } catch {
        /* ignore */
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

export const SHADOW_HELPERS = `
function deepAll(pred){var out=[];function walk(root){var els=root.querySelectorAll('*');for(var i=0;i<els.length;i++){var e=els[i];try{if(pred(e))out.push(e);}catch(_){}if(e.shadowRoot)walk(e.shadowRoot);}}walk(document);return out;}
function vis(el){if(!el)return false;var b=el.getBoundingClientRect();var s=getComputedStyle(el);return b.width>0&&b.height>0&&s.visibility!='hidden'&&s.display!='none'&&s.opacity!='0';}
function aria(e){return ((e.getAttribute&&e.getAttribute('aria-label'))||'');}
function label(e){return (aria(e)||e.innerText||'').trim();}
`;