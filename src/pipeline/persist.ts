import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicJson } from '../automation/core/atomic.js';
import type { Store } from '../automation/core/store.js';

export function readJsonFile<T>(rootDir: string, name: string, fallback: T): T {
  const path = join(rootDir, name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile<T>(rootDir: string, name: string, value: T): void {
  writeAtomicJson(join(rootDir, name), value);
}

export type PipelineStore = Store & {
  readJson<T>(name: string, fallback: T): T;
  writeJson<T>(name: string, value: T): void;
};

function hasInMemoryJson(store: Store): store is Store & {
  readJson: <T>(name: string, fallback: T) => T;
  writeJson: <T>(name: string, value: T) => void;
} {
  const candidate = store as { readJson?: unknown; writeJson?: unknown };
  return typeof candidate.readJson === 'function' && typeof candidate.writeJson === 'function';
}

export function asPipelineStore(store: Store): PipelineStore {
  const json = {
    readJson<T>(name: string, fallback: T): T {
      if (hasInMemoryJson(store)) return store.readJson(name, fallback);
      return readJsonFile(store.rootDir, name, fallback);
    },
    writeJson<T>(name: string, value: T): void {
      if (hasInMemoryJson(store)) {
        store.writeJson(name, value);
        return;
      }
      writeJsonFile(store.rootDir, name, value);
    },
  };
  return {
    rootDir: store.rootDir,
    readState: () => store.readState(),
    writeState: (state) => store.writeState(state),
    appendLedger: (row) => store.appendLedger(row),
    readLedger: () => store.readLedger(),
    latestLedgerByField: (field) => store.latestLedgerByField(field),
    acquireLock: () => store.acquireLock(),
    releaseLock: () => store.releaseLock(),
    readPending: store.readPending ? () => store.readPending!() : undefined,
    writePending: store.writePending ? (p) => store.writePending!(p) : undefined,
    ...json,
  };
}