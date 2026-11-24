import type { InviteRunConfig } from './types.js';

export const DEFAULT_INVITE_CONFIG: InviteRunConfig = {
  dryRun: true,
  rollingWindowMs: 7 * 86_400_000,
  rollingMaxInvites: 100,
  cooldownDaysOnLimit: 7,
  unavailableBackoffHours: [6, 24],
  securityWarningStops: true,
  minGapSec: 45,
  maxGapSec: 120,
};