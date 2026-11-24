import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomicJson } from '../core/atomic.js';

export type MessageDraft = {
  id: string;
  conversationUrn: string;
  inboundFp: string;
  text: string;
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'send_failed';
  createdAt: string;
};

export function draftsPath(rootDir: string): string {
  return join(rootDir, 'message-drafts.json');
}

export function readDrafts(rootDir: string): MessageDraft[] {
  const p = draftsPath(rootDir);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8')) as { drafts?: MessageDraft[] };
    return data.drafts ?? [];
  } catch {
    return [];
  }
}

export function writeDrafts(rootDir: string, drafts: MessageDraft[]): void {
  writeAtomicJson(draftsPath(rootDir), { drafts, updatedAt: new Date().toISOString() });
}