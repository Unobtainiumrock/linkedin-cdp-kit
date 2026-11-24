import type { CdpTarget, CdpVersion } from './types.js';

export async function fetchJsonVersion(cdpBase: string): Promise<CdpVersion> {
  const resp = await fetch(`${cdpBase.replace(/\/$/, '')}/json/version`);
  if (!resp.ok) throw new Error(`CDP /json/version HTTP ${resp.status}`);
  return (await resp.json()) as CdpVersion;
}

export async function listTargets(cdpBase: string): Promise<CdpTarget[]> {
  const resp = await fetch(`${cdpBase.replace(/\/$/, '')}/json`);
  if (!resp.ok) throw new Error(`CDP /json HTTP ${resp.status}`);
  return (await resp.json()) as CdpTarget[];
}

export function rewriteWsUrl(wsUrl: string, cdpBase: string): string {
  try {
    const cdpHost = new URL(cdpBase);
    return wsUrl.replace(/wss?:\/\/[^/]+/, `ws://${cdpHost.host}`);
  } catch {
    return wsUrl;
  }
}

export function findLinkedInPageTab(tabs: CdpTarget[]): CdpTarget | null {
  const linkedInPages = tabs.filter(
    (t) =>
      t.type === 'page' &&
      typeof t.url === 'string' &&
      /^https:\/\/(www\.)?linkedin\.com\//.test(t.url),
  );
  const preferred = linkedInPages.find((t) => !t.url.includes('/messaging/thread/'));
  return preferred ?? linkedInPages[0] ?? null;
}

export async function openNewTab(cdpBase: string, url: string): Promise<CdpTarget> {
  const targetUrl = new URL(url);
  if (targetUrl.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(targetUrl.hostname)) {
    throw new TypeError('openNewTab requires an https://linkedin.com URL');
  }
  const response = await fetch(`${cdpBase.replace(/\/$/, '')}/json/new?${encodeURI(targetUrl.toString())}`, {
    method: 'PUT',
  });
  if (!response.ok) throw new Error(`Could not create CDP tab: HTTP ${response.status}`);
  return (await response.json()) as CdpTarget;
}

export async function closeTab(cdpBase: string, targetId: string): Promise<boolean> {
  if (!targetId || !/^[A-Fa-f0-9]+$/.test(targetId)) return false;
  try {
    const response = await fetch(`${cdpBase.replace(/\/$/, '')}/json/close/${targetId}`);
    return response.ok;
  } catch {
    return false;
  }
}