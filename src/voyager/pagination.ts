export function makePaginationToken(activityId: string | bigint): string {
  if (typeof activityId === 'number') {
    throw new TypeError(
      'makePaginationToken: pass the activity id as a string or BigInt — a Number loses precision above 2^53.',
    );
  }
  const raw = String(activityId ?? '').trim();
  if (typeof activityId !== 'bigint' && !/^\d+$/.test(raw)) {
    throw new TypeError(`makePaginationToken: invalid activity id ${JSON.stringify(activityId)}`);
  }
  const id = BigInt(typeof activityId === 'bigint' ? activityId : raw);
  if (id <= 0n) throw new TypeError(`makePaginationToken: activity id must be positive, got ${id}`);
  const payload = `urn:li:activity:${id}-${id >> 22n}`;
  return encodeURIComponent(Buffer.from(payload, 'utf8').toString('base64'));
}