import type { ParsedProfile } from '../parse/profile.js';

export type ExpectedAccount = {
  publicIdentifier?: string;
  profileUrn?: string;
};

export type AccountGuardResult =
  | { ok: true; profile: Pick<ParsedProfile, 'publicIdentifier' | 'profileUrn' | 'name'> }
  | { ok: false; reason: 'missing_identity' | 'slug_mismatch' | 'urn_mismatch' };

export function checkAccountGuard(
  profile: Pick<ParsedProfile, 'publicIdentifier' | 'profileUrn' | 'name'> | null,
  expected?: ExpectedAccount,
): AccountGuardResult {
  if (!profile?.publicIdentifier || !profile.profileUrn) {
    return { ok: false, reason: 'missing_identity' };
  }
  if (!expected) {
    return { ok: true, profile };
  }
  if (expected.publicIdentifier && profile.publicIdentifier !== expected.publicIdentifier) {
    return { ok: false, reason: 'slug_mismatch' };
  }
  if (expected.profileUrn && profile.profileUrn !== expected.profileUrn) {
    return { ok: false, reason: 'urn_mismatch' };
  }
  return { ok: true, profile };
}