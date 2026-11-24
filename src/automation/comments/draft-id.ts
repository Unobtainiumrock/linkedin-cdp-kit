import { createHash } from 'node:crypto';

export function commentDraftId(parts: { targetSlug: string; text: string; activityId: string }): string {
  const payload = `${parts.targetSlug}\n${parts.text.trim()}\n${parts.activityId}`;
  return createHash('sha256').update(payload).digest('hex');
}