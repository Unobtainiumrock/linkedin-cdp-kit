import { readFeed, reactToPost, sharePost, listComments, replyToComment } from './actions/feed.js';
import { commentOnPostLive } from './actions/comment.js';
import { captureAndDraft, runCommentExecutor, approveProposal } from './automation/comments/pipeline.js';
import {
  filterCommentContent,
  contentRefusal,
} from './automation/comments/content-filter.js';
import {
  loadReferenceBundle,
  builtinMaxLengthLinter,
  draftWithReviseOnce,
  TargetRotationSelector,
} from './pipeline/comments-plugins.js';
import { searchPeople } from './actions/people-search.js';
import { probeConnectability } from './actions/connectability.js';
import { sendConnectionInviteLive } from './actions/invite.js';
import { runInvites, inviteStatus, resumeInvites } from './automation/invites/runner.js';
import { runRefill } from './pipeline/discovery.js';
import {
  defaultScoreGrader,
  applyGradeToQueue,
  applyGradeToQueueAsync,
  orderQualifiedQueue,
} from './pipeline/grading.js';
import { runVerify } from './pipeline/verify.js';
import {
  readContactLedger,
  writeContactLedger,
  listContacts,
  importConnectionsCsv,
  syncConnectionsFromScrape,
} from './pipeline/contacts.js';
import { scrapeConnections } from './actions/scrape-connections.js';
import {
  FixedCooldownPolicy,
  LimitHitCooldownPolicy,
  BayesianCooldownPolicy,
  isCooldownActive,
} from './pipeline/cooldown.js';
import { auditUnavailable, applyUnavailableAudit } from './pipeline/audit.js';
import { listConversations } from './voyager/inbox.js';
import { pullThread } from './actions/scrape-thread.js';
import { sendMessageLive } from './actions/send-message.js';
import { matchConversationsByName } from './actions/resolve.js';
import { LinkedInMessageListener } from './actions/listen.js';
import { ingestConversation, ingestAndQueueDrafts } from './automation/messaging/ingest.js';
import { readDrafts, writeDrafts } from './automation/messaging/queue.js';
import { createNudgeDrafts, shouldCreateNudge } from './automation/messaging/followup.js';
import { KeywordIntentRouter, routeAndDraft } from './pipeline/messaging-plugins.js';
import { easyApplyToJob } from './actions/easy-apply.js';

/** Content automation: feed, reactions, shares, comments, and comment pipeline plugins. */
export const content = {
  readFeed,
  reactToPost,
  sharePost,
  listComments,
  commentOnPostLive,
  replyToComment,
  captureAndDraft,
  approveProposal,
  runCommentExecutor,
  loadReferenceBundle,
  builtinMaxLengthLinter,
  draftWithReviseOnce,
  TargetRotationSelector,
  filterCommentContent,
  contentRefusal,
} as const;

/** Outreach automation: discovery, grading, invites, contacts, and connection tooling. */
export const outreach = {
  searchPeople,
  probeConnectability,
  sendConnectionInviteLive,
  runInvites,
  inviteStatus,
  resumeInvites,
  runRefill,
  defaultScoreGrader,
  applyGradeToQueue,
  applyGradeToQueueAsync,
  orderQualifiedQueue,
  runVerify,
  readContactLedger,
  writeContactLedger,
  listContacts,
  importConnectionsCsv,
  syncConnectionsFromScrape,
  scrapeConnections,
  FixedCooldownPolicy,
  LimitHitCooldownPolicy,
  BayesianCooldownPolicy,
  isCooldownActive,
  auditUnavailable,
  applyUnavailableAudit,
} as const;

/** Messaging automation: inbox reads, sends, ingest, drafts, follow-ups, and intent routing. */
export const messaging = {
  listConversations,
  pullThread,
  sendMessageLive,
  matchConversationsByName,
  LinkedInMessageListener,
  ingestConversation,
  ingestAndQueueDrafts,
  readDrafts,
  writeDrafts,
  createNudgeDrafts,
  shouldCreateNudge,
  KeywordIntentRouter,
  routeAndDraft,
} as const;

/** Application automation: attended Easy Apply job flows. */
export const applications = {
  easyApplyToJob,
} as const;

export type ContentLane = typeof content;
export type OutreachLane = typeof outreach;
export type MessagingLane = typeof messaging;
export type ApplicationsLane = typeof applications;