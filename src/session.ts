import type { BrowserProvider } from './cdp/browser-provider.js';
import { attachToCdpUrl } from './cdp/browser-provider.js';
import type { CdpSession } from './cdp/session.js';
import { buildFetchCurrentProfile } from './voyager/builders.js';
import { parseProfile } from './parse/profile.js';
import { checkAccountGuard, type ExpectedAccount } from './session/account-guard.js';
import { listConversations, type ListConversationsOptions } from './voyager/inbox.js';
import { pullProfile } from './voyager/profile-pull.js';
import type { ParsedConversation } from './parse/messaging.js';
import type { PullProfileResult } from './voyager/profile-pull.js';

export type LinkedInSessionConnectOptions = {
  cdpUrl: string;
  expectedAccount?: ExpectedAccount;
  freshTab?: boolean | string;
  browser?: BrowserProvider;
  log?: (msg: string) => void;
};

export type MeIdentity = {
  csrfToken: string;
  mailboxUrn: string;
  publicIdentifier: string | null;
  profileUrn: string;
  displayName: string | null;
};

export class LinkedInSession {
  private lease: Awaited<ReturnType<BrowserProvider['acquire']>> | null = null;
  session: CdpSession | null = null;
  csrfToken: string | null = null;
  me: MeIdentity | null = null;
  private readonly log: (msg: string) => void;

  constructor(log?: (msg: string) => void) {
    this.log = log ?? (() => {});
  }

  get connected(): boolean {
    return Boolean(this.session && this.me?.mailboxUrn);
  }

  get evaluateSession(): { csrfToken: string; evaluate: CdpSession['evaluate'] } | null {
    if (!this.session || !this.csrfToken) return null;
    return { csrfToken: this.csrfToken, evaluate: (expr, t) => this.session!.evaluate(expr, t) };
  }

  async connect(opts: LinkedInSessionConnectOptions): Promise<LinkedInSession> {
    if (this.connected) return this;

    const provider = opts.browser ?? attachToCdpUrl(opts.cdpUrl);
    const freshUrl =
      opts.freshTab === true
        ? 'https://www.linkedin.com/feed/'
        : typeof opts.freshTab === 'string'
          ? opts.freshTab
          : null;

    this.lease = await provider.acquire({ freshTabUrl: freshUrl });
    this.session = this.lease.session;

    if (freshUrl) {
      await this.waitForAuthenticatedTab();
    }

    this.csrfToken = await this.extractCsrfToken();
    this.me = await this.loadIdentity(opts.expectedAccount);
    return this;
  }

  private async waitForAuthenticatedTab(): Promise<void> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      try {
        const ready = await this.session!.evaluate(
          'location.hostname.endsWith("linkedin.com") && document.cookie.includes("JSESSIONID=")',
          3_000,
        );
        if (ready === true) return;
      } catch {
        /* navigation teardown */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Fresh LinkedIn tab did not become authenticated');
  }

  private async extractCsrfToken(): Promise<string> {
    const token = await this.session!.evaluate(`
      (function() {
        const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
        return match ? match[1] : null;
      })()
    `);
    if (!token || typeof token !== 'string') {
      throw new Error('Could not extract CSRF token. Are you logged into LinkedIn?');
    }
    return token;
  }

  private async loadIdentity(expected?: ExpectedAccount): Promise<MeIdentity> {
    const raw = await this.session!.evaluate(buildFetchCurrentProfile(this.csrfToken!));
    let data: unknown = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error('Unparseable /voyager/api/me response');
      }
    }

    const parsed = parseProfile(data);
    const mini = (data as { included?: Array<{ firstName?: string; lastName?: string; entityUrn?: string }> })
      ?.included?.find((i) => i.firstName);
    const rawUrn =
      mini?.entityUrn ??
      (data as { data?: { entityUrn?: string; '*miniProfile'?: string } })?.data?.entityUrn ??
      (data as { data?: { '*miniProfile'?: string } })?.data?.['*miniProfile'];

    const identity = {
      publicIdentifier: parsed?.publicIdentifier ?? null,
      profileUrn: parsed?.profileUrn ?? (typeof rawUrn === 'string' ? rawUrn : ''),
      name: parsed?.name ?? null,
    };

    const guard = checkAccountGuard(identity, expected);
    if (!guard.ok) {
      throw new Error(`LinkedIn account guard failed: ${guard.reason}`);
    }

    if (!identity.profileUrn) {
      throw new Error('Could not determine profile URN from /voyager/api/me');
    }

    if (identity.name) this.log(`Logged in as: ${identity.name}`);

    return {
      csrfToken: this.csrfToken!,
      mailboxUrn: identity.profileUrn,
      publicIdentifier: identity.publicIdentifier,
      profileUrn: identity.profileUrn,
      displayName: identity.name,
    };
  }

  async listConversations(opts?: ListConversationsOptions): Promise<ParsedConversation[]> {
    this.assertConnected();
    return listConversations(
      {
        csrfToken: this.csrfToken!,
        mailboxUrn: this.me!.mailboxUrn,
        evaluate: (expr, t) => this.session!.evaluate(expr, t),
      },
      opts,
    );
  }

  async getProfile(slugOrUrl: string, opts?: Parameters<typeof pullProfile>[2]): Promise<PullProfileResult> {
    this.assertConnected();
    const vs = this.evaluateSession!;
    return pullProfile(vs, slugOrUrl, opts);
  }

  async close(): Promise<void> {
    try {
      this.session?.close();
    } catch {
      /* ignore */
    }
    if (this.lease) {
      await this.lease.closeTab();
    }
    this.lease = null;
    this.session = null;
    this.csrfToken = null;
    this.me = null;
  }

  assertConnectedPublic(): void {
    this.assertConnected();
  }

  private assertConnected(): void {
    if (!this.connected) throw new Error('LinkedInSession is not connected');
  }
}