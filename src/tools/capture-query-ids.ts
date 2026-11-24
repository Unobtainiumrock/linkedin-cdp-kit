import type { CdpSession } from '../cdp/session.js';

export type CapturedQueryId = {
  queryId: string;
  url: string;
  capturedAt: string;
};

const GRAPHQL_PATH = '/voyager/api/graphql';

export function extractQueryIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url, 'https://www.linkedin.com');
    if (!u.pathname.includes(GRAPHQL_PATH)) return null;
    const q = u.searchParams.get('queryId');
    return q || null;
  } catch {
    const m = /queryId=([^&]+)/.exec(url);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  }
}

/**
 * Attach a Network.requestWillBeSent listener and collect live queryId values.
 */
export async function captureGraphqlQueryIds(
  session: CdpSession,
  opts: { timeoutMs?: number; onCapture?: (entry: CapturedQueryId) => void } = {},
): Promise<CapturedQueryId[]> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  await session.send('Network.enable', {}, 10_000);

  const captured: CapturedQueryId[] = [];
  const seen = new Set<string>();

  const handler = (raw: string) => {
    try {
      const msg = JSON.parse(raw) as {
        method?: string;
        params?: { request?: { url?: string } };
      };
      if (msg.method !== 'Network.requestWillBeSent') return;
      const url = msg.params?.request?.url;
      if (!url || !url.includes(GRAPHQL_PATH)) return;
      const queryId = extractQueryIdFromUrl(url);
      if (!queryId || seen.has(queryId)) return;
      seen.add(queryId);
      const entry: CapturedQueryId = { queryId, url, capturedAt: new Date().toISOString() };
      captured.push(entry);
      opts.onCapture?.(entry);
    } catch {
      /* ignore */
    }
  };

  session.onMessage(handler);
  await new Promise((r) => setTimeout(r, timeoutMs));
  session.offMessage(handler);
  return captured;
}