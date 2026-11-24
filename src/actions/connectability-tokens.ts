export function tokenizeNameLike(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function verifyNameTokens(expected: string, observed: string): boolean {
  const need = tokenizeNameLike(expected);
  if (need.length === 0) return true;
  const have = new Set(tokenizeNameLike(observed));
  return need.every((t) => have.has(t));
}