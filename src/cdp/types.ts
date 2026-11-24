export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
};

export type CdpVersion = {
  Browser: string;
  'Protocol-Version': string;
  webSocketDebuggerUrl?: string;
};

export type EvaluateResult<T = unknown> = T;