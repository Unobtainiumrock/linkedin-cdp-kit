import { jitteredDelay } from '../pacing.js';

export type ScrapeConnectionsOptions = {
  live?: boolean;
  anchorCap?: number;
  wallClockCapMs?: number;
  minScrollDelayMs?: number;
  maxScrollDelayMs?: number;
};

export type ScrapedConnection = {
  name: string;
  slug: string;
  profileUrl: string;
  connected?: string;
};

export type ScrapeConnectionsResult =
  | { status: 'dry_run'; cap: number }
  | { status: 'complete' | 'capped' | 'manual_review'; connections: ScrapedConnection[]; reason?: string };

export const CONNECTIONS_PAGE_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';

export async function scrapeConnections(opts: ScrapeConnectionsOptions = {}): Promise<ScrapeConnectionsResult> {
  const cap = opts.anchorCap ?? 300;
  if (!opts.live) {
    return { status: 'dry_run', cap };
  }
  return { status: 'manual_review', connections: [], reason: 'live_scrape_requires_cdp_session' };
}

export function nextScrollDelay(opts: ScrapeConnectionsOptions): Promise<void> {
  const min = opts.minScrollDelayMs ?? 1_800;
  const max = opts.maxScrollDelayMs ?? 4_200;
  return jitteredDelay(min, max);
}