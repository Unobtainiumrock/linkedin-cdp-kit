import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicJson } from './atomic.js';
import type { PendingProposal } from '../comments/pipeline.js';

export function pendingPath(rootDir: string): string {
  return join(rootDir, 'pending.json');
}

export function readPendingProposals(rootDir: string): PendingProposal[] {
  const path = pendingPath(rootDir);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { proposals?: PendingProposal[] };
    return Array.isArray(data.proposals) ? data.proposals : [];
  } catch {
    return [];
  }
}

export function writePendingProposals(rootDir: string, proposals: PendingProposal[]): void {
  writeAtomicJson(pendingPath(rootDir), { proposals, updatedAt: new Date().toISOString() });
}