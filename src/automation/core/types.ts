export type RuntimeMode = 'ready' | 'cooldown' | 'review' | 'paused';

export type RuntimeState = {
  mode: RuntimeMode;
  reason?: string;
  since?: string;
  cooldownUntil?: string;
  reviewReason?: string;
  killSwitch?: boolean;
  updatedAt?: string;
};

export type LedgerRow = {
  id: string;
  at: string;
  status: string;
  [key: string]: unknown;
};

export type GateResult =
  | { ok: true }
  | { ok: false; code: string; detail?: string };

export type NotifyEvent =
  | { type: 'posted'; detail: Record<string, unknown> }
  | { type: 'held'; reason: string; detail?: Record<string, unknown> }
  | { type: 'paused'; reason: string };

export type NotifyHook = (event: NotifyEvent) => void | Promise<void>;

export type RunReport = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  module: string;
  actions: Array<Record<string, unknown>>;
  gateBlocks: string[];
  held: boolean;
  error?: string;
};