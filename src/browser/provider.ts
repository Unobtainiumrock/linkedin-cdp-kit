import { attachToCdpUrl, type AttachToCdpUrlProvider, type BrowserLease, type BrowserProvider } from '../cdp/browser-provider.js';
import type { CdpSessionOptions } from '../cdp/session.js';
import { launchChrome, type LaunchChromeOptions } from './launch.js';
import { waitForNetwork, type WaitForNetworkOptions } from './network.js';

export type IsolatedChromeLaunchOptions = LaunchChromeOptions & {
  freshTabUrl?: string | null;
  sessionOpts?: CdpSessionOptions;
  networkCheck?: boolean | WaitForNetworkOptions;
};

export class LaunchIsolatedChromeProvider implements BrowserProvider {
  private readonly launchOpts: Omit<IsolatedChromeLaunchOptions, 'freshTabUrl' | 'sessionOpts' | 'networkCheck'>;
  private readonly sessionOpts?: CdpSessionOptions;
  private readonly networkCheck: boolean | WaitForNetworkOptions;
  private chrome: ReturnType<typeof launchChrome> | null = null;
  private attach: AttachToCdpUrlProvider | null = null;

  constructor(opts: IsolatedChromeLaunchOptions) {
    const { freshTabUrl: _f, sessionOpts, networkCheck, ...launch } = opts;
    void _f;
    this.launchOpts = launch;
    this.sessionOpts = sessionOpts;
    this.networkCheck = networkCheck ?? true;
  }

  async acquire(opts: { freshTabUrl?: string | null } = {}): Promise<BrowserLease> {
    if (this.networkCheck) {
      const netOpts = typeof this.networkCheck === 'object' ? this.networkCheck : {};
      await waitForNetwork(netOpts);
    }
    if (!this.chrome) {
      this.chrome = launchChrome(this.launchOpts);
      this.attach = attachToCdpUrl(this.chrome.cdpUrl, { sessionOpts: this.sessionOpts });
    }
    if (!this.attach) throw new Error('attach_missing');
    return this.attach.acquire(opts);
  }

  /** Signals only the browser pid launched here. */
  stopBrowser(): void {
    this.chrome?.stop();
    this.chrome = null;
    this.attach = null;
  }
}

export function launchIsolatedChrome(opts: IsolatedChromeLaunchOptions): LaunchIsolatedChromeProvider {
  return new LaunchIsolatedChromeProvider(opts);
}