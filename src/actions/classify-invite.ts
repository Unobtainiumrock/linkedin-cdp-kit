export type InviteClassification =
  | 'sent'
  | 'rejected_limit'
  | 'rejected_resend'
  | 'uncertain';

export type ClassifiedInvite = {
  result: InviteClassification;
  value: Record<string, unknown> | null;
};

export function classifyInviteResponse(status: number, body: unknown): ClassifiedInvite {
  if (!body || typeof body !== 'object') {
    return { result: 'uncertain', value: null };
  }
  const root = body as Record<string, unknown>;
  const data = root['data'];
  if (!data || typeof data !== 'object') {
    return { result: 'uncertain', value: null };
  }
  const dataObj = data as Record<string, unknown>;
  const code = dataObj['code'] ?? root['code'];

  if (code === 'FUSE_LIMIT_EXCEEDED' && (status === 429 || dataObj['status'] === 429)) {
    return { result: 'rejected_limit', value: null };
  }
  if (code === 'CANT_RESEND_YET' && (status === 400 || dataObj['status'] === 400)) {
    return { result: 'rejected_resend', value: null };
  }

  const value = dataObj['value'];
  if (
    status === 200 &&
    (root['status'] as number | undefined ?? 200) < 400 &&
    (dataObj['status'] as number | undefined ?? 200) < 400 &&
    value &&
    typeof value === 'object'
  ) {
    const urn = (value as Record<string, unknown>)['invitationUrn'];
    if (typeof urn === 'string' && urn.startsWith('urn:li:fsd_invitation:')) {
      return { result: 'sent', value: value as Record<string, unknown> };
    }
  }

  return { result: 'uncertain', value: null };
}

export function normalizeNameKey(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function recipientDialogMatches(
  candidateName: string,
  dialogText: string,
  inviteName?: string,
): boolean {
  const m = /Personalize your invitation to (.+?) by adding a note\./s.exec(dialogText);
  if (!m?.[1]) return false;
  const dialogName = normalizeNameKey(m[1]);
  const keys = new Set([normalizeNameKey(candidateName), normalizeNameKey(inviteName ?? candidateName)]);
  return keys.has(dialogName) || [...keys].some((k) => dialogName.includes(k));
}

export const RELATIONSHIPS_POST_PATH = '/voyager/api/voyagerRelationshipsDashMemberRelationships';

export function customInviteUrl(vanityName: string): string {
  const slug = encodeURIComponent(vanityName).replace(/%2F/g, '/');
  return `https://www.linkedin.com/preload/custom-invite/?vanityName=${slug}`;
}