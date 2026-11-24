import type { CdpSession } from '../cdp/session.js';
import type { ParsedConversation, ParsedMessage } from '../parse/messaging.js';
import type { PullProfileResult } from '../voyager/profile-pull.js';
import type { SendMessageResult } from './send-message.js';
import type { CommentLiveResult } from './comment.js';
import type { ConnectionInviteResult } from './invite.js';

export type ActionSession = {
  cdp: CdpSession;
  evaluate: (expression: string, timeoutMs?: number) => Promise<unknown>;
  csrfToken: string;
  mailboxUrn: string;
  publicIdentifier: string | null;
  displayName: string | null;
};

export interface LinkedInActions {
  fetchProfile(slugOrUrl: string, opts?: { posts?: boolean }): Promise<PullProfileResult>;
  listConversations(opts?: { days?: number }): Promise<ParsedConversation[]>;
  getMessages(conversationUrn: string): Promise<ParsedMessage[]>;
  sendMessage(conversationUrn: string, text: string, opts?: SendMessageOpts): Promise<DomSendResult>;
  commentOnPost(postUrl: string, text: string, opts?: CommentPostOpts): Promise<CommentLiveResult>;
  sendConnectionInvite(candidate: InviteCandidateInput, opts?: InviteSendOpts): Promise<ConnectionInviteResult>;
  verifySentInvites(recipientName: string): Promise<VerifySentResult>;
}

export type SendMessageOpts = {
  live?: boolean;
  allowVoyagerFallback?: boolean;
  mode?: 'dom' | 'voyager' | 'auto';
};

export type DomSendResult =
  | {
      ok: true;
      verified: boolean;
      conversationUrn: string;
      threadId: string;
      reason?: string;
      modeUsed?: string | null;
      authwall?: boolean;
      attempts?: Array<Record<string, unknown>>;
    }
  | {
      ok: false;
      reason: string;
      conversationUrn: string;
      threadId?: string;
      verified?: boolean;
      modeUsed?: string | null;
      authwall?: boolean;
      attempts?: Array<Record<string, unknown>>;
    };

export type CommentPostOpts = {
  live?: boolean;
  expectedProfileSlug?: string;
  screenshotPath?: string;
};

export type InviteCandidateInput = {
  vanityName: string;
  recipientName: string;
  inviteName?: string;
  note?: string;
  expectedProfileUrn?: string;
};

export type InviteSendOpts = {
  live?: boolean;
  useProfileFallback?: boolean;
  dryRunNavigate?: boolean;
};

export type VerifySentResult = {
  ok: boolean;
  peopleLabelFound: boolean;
  recipientVisible: boolean;
  withdrawVisible: boolean;
  detail?: string;
};