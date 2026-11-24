import { LinkedInSession } from '../session.js';
import { buildFetchMessages } from '../voyager/builders.js';
import { parseMessages } from '../parse/messaging.js';
import { pullProfile } from '../voyager/profile-pull.js';
import type { InviteCandidateInput, LinkedInActions } from './types.js';
import { sendMessageLive } from './send-message.js';
import { commentOnPostLive } from './comment.js';
import { sendConnectionInviteLive, verifySentInvites as verifySentInvitesPage } from './invite.js';
import type { ActionSession } from './types.js';

function toActionSession(li: LinkedInSession): ActionSession {
  if (!li.session || !li.csrfToken || !li.me) throw new Error('LinkedInSession not connected');
  return {
    cdp: li.session,
    evaluate: (expr, t) => li.session!.evaluate(expr, t),
    csrfToken: li.csrfToken,
    mailboxUrn: li.me.mailboxUrn,
    publicIdentifier: li.me.publicIdentifier,
    displayName: li.me.displayName,
  };
}

export class SessionLinkedInActions implements LinkedInActions {
  constructor(readonly linkedInSession: LinkedInSession) {}

  private actionSession(): ActionSession {
    return toActionSession(this.linkedInSession);
  }

  async fetchProfile(slugOrUrl: string, opts?: { posts?: boolean }) {
    this.linkedInSession.assertConnectedPublic();
    const vs = this.linkedInSession.evaluateSession!;
    return pullProfile(vs, slugOrUrl, opts);
  }

  async listConversations(opts?: { days?: number }) {
    return this.linkedInSession.listConversations(opts);
  }

  async getMessages(conversationUrn: string) {
    this.linkedInSession.assertConnectedPublic();
    const vs = this.linkedInSession.evaluateSession!;
    const raw = await vs.evaluate(buildFetchMessages(vs.csrfToken, conversationUrn));
    let data: unknown = raw;
    if (typeof raw === 'string') data = JSON.parse(raw);
    return parseMessages(data as Parameters<typeof parseMessages>[0]);
  }

  async sendMessage(conversationUrn: string, text: string, opts = {}) {
    return sendMessageLive(this.actionSession(), conversationUrn, text, opts);
  }

  async commentOnPost(postUrl: string, text: string, opts = {}) {
    return commentOnPostLive(this.actionSession(), postUrl, text, opts);
  }

  async sendConnectionInvite(candidate: InviteCandidateInput, opts = {}) {
    return sendConnectionInviteLive(this.actionSession(), candidate, opts);
  }

  async verifySentInvites(recipientName: string) {
    return verifySentInvitesPage(this.actionSession(), recipientName);
  }
}