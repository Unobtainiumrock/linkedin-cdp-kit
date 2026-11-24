export function assertProfileUrn(profileUrn: string): string {
  if (typeof profileUrn !== 'string' || !/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/.test(profileUrn)) {
    throw new TypeError(`Invalid profile URN: ${JSON.stringify(profileUrn)}`);
  }
  return profileUrn;
}

export function assertCount(name: string, value: number, { min = 0, max = 100 }: { min?: number; max?: number } = {}): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
  return value;
}

export function assertPaginationToken(token: string | null | undefined): string | null {
  if (token === null || token === undefined) return null;
  if (typeof token !== 'string' || !/^[A-Za-z0-9+/=]+(%3D)*$/.test(token)) {
    throw new TypeError(`Invalid pagination token: ${JSON.stringify(token)}`);
  }
  return token;
}