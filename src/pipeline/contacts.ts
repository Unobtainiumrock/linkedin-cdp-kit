import { readFileSync, existsSync } from 'node:fs';
import { normalizeDiscoverySlug } from './discovery.js';
import { asPipelineStore, type PipelineStore } from './persist.js';
import type { Store } from '../automation/core/store.js';
import type { ScrapedConnection } from '../actions/scrape-connections.js';

export type ContactLifecycleState =
  | 'discovered'
  | 'needs_research'
  | 'qualified'
  | 'invited'
  | 'connected'
  | 'commented'
  | 'messaged';

export type ContactRecord = {
  slug: string;
  name: string;
  state: ContactLifecycleState;
  optOut: boolean;
  connectedOn?: string;
  updatedAt: string;
  invitedAt?: string;
  commentedAt?: string;
  messagedAt?: string;
};

const CONTACTS_FILE = 'contacts-ledger.json';

function pipelineStore(store: Store | PipelineStore): PipelineStore {
  return asPipelineStore(store);
}

export function readContactLedger(store: Store | PipelineStore): ContactRecord[] {
  return pipelineStore(store).readJson<ContactRecord[]>(CONTACTS_FILE, []);
}

export function writeContactLedger(store: Store | PipelineStore, rows: ContactRecord[]): void {
  pipelineStore(store).writeJson(CONTACTS_FILE, rows);
}

function upsert(records: ContactRecord[], patch: ContactRecord): ContactRecord[] {
  const idx = records.findIndex((r) => r.slug === patch.slug);
  const next = [...records];
  if (idx >= 0) next[idx] = { ...records[idx]!, ...patch, updatedAt: new Date().toISOString() };
  else next.push({ ...patch, updatedAt: new Date().toISOString() });
  return next;
}

export function transitionContact(
  store: Store | PipelineStore,
  slug: string,
  name: string,
  state: ContactLifecycleState,
  extra: Partial<ContactRecord> = {},
): ContactRecord {
  const normalized = normalizeDiscoverySlug(slug);
  const now = new Date().toISOString();
  const row: ContactRecord = {
    slug: normalized,
    name,
    state,
    optOut: extra.optOut ?? false,
    updatedAt: now,
    ...extra,
  };
  if (state === 'connected' && !row.connectedOn) row.connectedOn = now.slice(0, 10);
  if (state === 'invited' && !row.invitedAt) row.invitedAt = now;
  if (state === 'commented' && !row.commentedAt) row.commentedAt = now;
  if (state === 'messaged' && !row.messagedAt) row.messagedAt = now;
  writeContactLedger(store, upsert(readContactLedger(store), row));
  return row;
}

export type ConnectionsCsvRow = {
  firstName: string;
  lastName: string;
  url: string;
  connectedOn: string;
};

function parseConnectionsLine(line: string, header: string[]): ConnectionsCsvRow | null {
  const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, '').trim());
  const get = (key: string): string => {
    const idx = header.indexOf(key);
    return idx >= 0 ? (cols[idx] ?? '') : '';
  };
  const firstName = get('First Name') || get('First name');
  const lastName = get('Last Name') || get('Last name');
  const url = get('URL') || get('Profile URL');
  const connectedOn = get('Connected On') || get('Connected on');
  if (!url) return null;
    const slugMatch = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (!slugMatch?.[1]) return null;
    return {
      firstName,
      lastName,
      url,
      connectedOn,
    };
}

export function importConnectionsCsv(store: Store | PipelineStore, filePath: string): { imported: number; skipped: number } {
  if (!existsSync(filePath)) return { imported: 0, skipped: 0 };
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const header = lines[0]?.split(',').map((h) => h.trim()) ?? [];
  let imported = 0;
  let skipped = 0;
  let ledger = readContactLedger(store);
  for (const line of lines.slice(1)) {
    const row = parseConnectionsLine(line, header);
    if (!row) {
      skipped += 1;
      continue;
    }
    const slug = normalizeDiscoverySlug(row.url.match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1] ?? '');
    const name = `${row.firstName} ${row.lastName}`.trim() || slug;
    ledger = upsert(ledger, {
      slug,
      name,
      state: 'connected',
      optOut: false,
      connectedOn: row.connectedOn || new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString(),
    });
    imported += 1;
  }
  writeContactLedger(store, ledger);
  return { imported, skipped };
}

export function syncConnectionsFromScrape(store: Store | PipelineStore, connections: ScrapedConnection[]): number {
  let ledger = readContactLedger(store);
  let n = 0;
  for (const c of connections) {
    const slug = normalizeDiscoverySlug(c.slug || c.profileUrl);
    ledger = upsert(ledger, {
      slug,
      name: c.name,
      state: 'connected',
      optOut: false,
      connectedOn: c.connected,
      updatedAt: new Date().toISOString(),
    });
    n += 1;
  }
  writeContactLedger(store, ledger);
  return n;
}

export function syncInviteSent(store: Store | PipelineStore, slug: string, name: string): void {
  transitionContact(store, slug, name, 'invited');
}

export function listContacts(store: Store | PipelineStore, filter?: { state?: ContactLifecycleState }): ContactRecord[] {
  const all = readContactLedger(store);
  if (!filter?.state) return all;
  return all.filter((c) => c.state === filter.state);
}