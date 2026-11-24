import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeAtomicJson } from './atomic.js';
import { readPendingProposals, writePendingProposals } from './pending.js';
import type { PendingProposal } from '../comments/pipeline.js';
import { tryAcquireRunLock, releaseRunLock } from './lock.js';
import type { LedgerRow, RuntimeState } from './types.js';

export type LedgerAppendInput = { status: string; id?: string; at?: string } & Record<string, unknown>;

export interface Store {
  rootDir: string;
  readState(): RuntimeState;
  writeState(state: RuntimeState): void;
  appendLedger(row: LedgerAppendInput): LedgerRow;
  readLedger(): LedgerRow[];
  latestLedgerByField(field: string): Map<string, LedgerRow>;
  acquireLock(): boolean;
  releaseLock(): void;
  readPending?(): PendingProposal[];
  writePending?(proposals: PendingProposal[]): void;
}

export type FileStorePaths = {
  rootDir: string;
  stateFile?: string;
  ledgerFile?: string;
  lockFile?: string;
};

export class FileStore implements Store {
  readonly rootDir: string;
  private readonly stateFile: string;
  private readonly ledgerFile: string;
  private readonly lockFile: string;
  private locked = false;

  constructor(paths: FileStorePaths) {
    this.rootDir = paths.rootDir;
    mkdirSync(this.rootDir, { recursive: true });
    this.stateFile = paths.stateFile ?? join(this.rootDir, 'runtime.json');
    this.ledgerFile = paths.ledgerFile ?? join(this.rootDir, 'ledger.jsonl');
    this.lockFile = paths.lockFile ?? join(this.rootDir, '.run.lock');
  }

  readState(): RuntimeState {
    if (!existsSync(this.stateFile)) return { mode: 'ready', killSwitch: false };
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as RuntimeState;
    } catch {
      return { mode: 'review', reason: 'corrupt_state' };
    }
  }

  writeState(state: RuntimeState): void {
    writeAtomicJson(this.stateFile, { ...state, updatedAt: new Date().toISOString() });
  }

  appendLedger(row: LedgerAppendInput): LedgerRow {
    const entry: LedgerRow = {
      ...row,
      status: row.status,
      id: row.id ?? randomUUID(),
      at: row.at ?? new Date().toISOString(),
    };
    appendFileSync(this.ledgerFile, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  }

  readLedger(): LedgerRow[] {
    if (!existsSync(this.ledgerFile)) return [];
    return readFileSync(this.ledgerFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerRow);
  }

  latestLedgerByField(field: string): Map<string, LedgerRow> {
    const map = new Map<string, LedgerRow>();
    for (const row of this.readLedger()) {
      const key = String(row[field] ?? '');
      if (!key) continue;
      map.set(key, row);
    }
    return map;
  }

  acquireLock(): boolean {
    const ok = tryAcquireRunLock(this.lockFile);
    this.locked = ok;
    return ok;
  }

  releaseLock(): void {
    if (!this.locked) return;
    releaseRunLock(this.lockFile);
    this.locked = false;
  }

  readPending(): PendingProposal[] {
    return readPendingProposals(this.rootDir);
  }

  writePending(proposals: PendingProposal[]): void {
    writePendingProposals(this.rootDir, proposals);
  }
}

export class InMemoryStore implements Store {
  readonly rootDir: string;
  private state: RuntimeState = { mode: 'ready', killSwitch: false };
  private ledger: LedgerRow[] = [];
  private pending: PendingProposal[] = [];
  private lockHeld = false;
  private readonly jsonDocs = new Map<string, unknown>();

  constructor(rootDir = '/tmp/in-memory-store') {
    this.rootDir = rootDir;
  }

  readState(): RuntimeState {
    return { ...this.state };
  }

  writeState(state: RuntimeState): void {
    this.state = { ...state };
  }

  appendLedger(row: LedgerAppendInput): LedgerRow {
    const entry: LedgerRow = {
      ...row,
      status: row.status,
      id: row.id ?? randomUUID(),
      at: row.at ?? new Date().toISOString(),
    };
    this.ledger.push(entry);
    return entry;
  }

  readLedger(): LedgerRow[] {
    return [...this.ledger];
  }

  latestLedgerByField(field: string): Map<string, LedgerRow> {
    const map = new Map<string, LedgerRow>();
    for (const row of this.ledger) {
      const key = String(row[field] ?? '');
      if (!key) continue;
      map.set(key, row);
    }
    return map;
  }

  acquireLock(): boolean {
    if (this.lockHeld) return false;
    this.lockHeld = true;
    return true;
  }

  releaseLock(): void {
    this.lockHeld = false;
  }

  readPending(): PendingProposal[] {
    return [...this.pending];
  }

  writePending(proposals: PendingProposal[]): void {
    this.pending = [...proposals];
  }

  readJson<T>(name: string, fallback: T): T {
    const hit = this.jsonDocs.get(name);
    return (hit === undefined ? fallback : hit) as T;
  }

  writeJson<T>(name: string, value: T): void {
    this.jsonDocs.set(name, value);
  }
}