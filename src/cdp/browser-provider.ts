import { closeTab, findLinkedInPageTab, listTargets, openNewTab, rewriteWsUrl } from './discovery.js';
import { CdpSession, type CdpSessionOptions } from './session.js';
import type { CdpTarget } from './types.js';

export type BrowserLease = {
  cdpBase: string;
  session: CdpSession;
  targetId: string | null;
  closeTab(): Promise<boolean>;
};

export type AttachToCdpUrlOptions = {
  cdpUrl: string;
  freshTabUrl?: string | null;
  sessionOpts?: CdpSessionOptions;
};

export interface BrowserProvider {
  acquire(opts: { freshTabUrl?: string | null }): Promise<BrowserLease>;
}

export class AttachToCdpUrlProvider implements BrowserProvider {
  private readonly cdpBase: string;
  private readonly sessionOpts?: CdpSessionOptions;

  constructor(cdpUrl: string, sessionOpts?: CdpSessionOptions) {
    this.cdpBase = cdpUrl.replace(/\/$/, '');
    this.sessionOpts = sessionOpts;
  }

  async acquire(opts: { freshTabUrl?: string | null } = {}): Promise<BrowserLease> {
    let target: CdpTarget | null = null;
    let wsUrl: string;

    if (opts.freshTabUrl) {
      target = await openNewTab(this.cdpBase, opts.freshTabUrl);
      wsUrl = rewriteWsUrl(target.webSocketDebuggerUrl, this.cdpBase);
    } else {
      const tabs = await listTargets(this.cdpBase);
      const tab = findLinkedInPageTab(tabs);
      if (!tab) {
        throw new Error(
          'No LinkedIn tab found. Launch Chrome with --remote-debugging-port and open linkedin.com.',
        );
      }
      target = tab;
      wsUrl = rewriteWsUrl(tab.webSocketDebuggerUrl, this.cdpBase);
    }

    const session = await CdpSession.connect(wsUrl, { targetId: target?.id ?? null }, this.sessionOpts ?? {});

    return {
      cdpBase: this.cdpBase,
      session,
      targetId: target?.id ?? null,
      closeTab: async () => {
        if (target?.id) return closeTab(this.cdpBase, target.id);
        return false;
      },
    };
  }
}

export function attachToCdpUrl(cdpUrl: string, opts: Omit<AttachToCdpUrlOptions, 'cdpUrl'> = {}): AttachToCdpUrlProvider {
  return new AttachToCdpUrlProvider(cdpUrl, opts.sessionOpts);
}