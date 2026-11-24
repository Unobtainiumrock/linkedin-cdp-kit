export type InviteCandidate = {
  slug: string;
  name: string;
  inviteName?: string;
  note?: string;
  optOut?: boolean;
};

export type QualifyResult =
  | { decision: 'qualify' }
  | { decision: 'reject'; reason: string }
  | { decision: 'needs_research'; reason: string };

export type InviteActionResult =
  | 'sent'
  | 'rejected_limit'
  | 'rejected_resend'
  | 'email_required'
  | 'unavailable'
  | 'recipient_name_mismatch'
  | 'uncertain'
  | 'skipped'
  | 'dry_run';

export type InviteRunConfig = {
  dryRun: boolean;
  rollingWindowMs: number;
  rollingMaxInvites: number;
  cooldownDaysOnLimit: number;
  unavailableBackoffHours: number[];
  securityWarningStops: boolean;
  minGapSec: number;
  maxGapSec: number;
  runBudgetMs?: number;
};