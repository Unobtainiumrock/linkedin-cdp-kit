import { getQueryIds } from './query-ids.js';
import { assertCount, assertPaginationToken, assertProfileUrn } from './validation.js';

export const PROFILE_DECORATION_ID =
  'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-90';

export const INBOX_CATEGORIES = Object.freeze([
  'PRIMARY_INBOX',
  'INMAIL',
  'MESSAGE_REQUEST',
  'OTHER',
] as const);

export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

function messagingGraphQL(queryId: string, variables: string, csrfToken: string): string {
  const url = `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${queryId}&variables=${variables}`;
  return `
    (async () => {
      try {
        const resp = await fetch("${url}", {
          headers: {
            "csrf-token": "${csrfToken}",
            "accept": "application/graphql",
            "x-restli-protocol-version": "2.0.0",
          },
          credentials: "include",
        });
        if (!resp.ok) return JSON.stringify({ error: resp.status, url: "${url}" });
        return await resp.text();
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    })()
  `;
}

function voyagerFetch(endpoint: string, csrfToken: string): string {
  return `
    (async () => {
      try {
        const resp = await fetch("${endpoint}", {
          headers: {
            "csrf-token": "${csrfToken}",
            "accept": "application/vnd.linkedin.normalized+json+2.1",
            "x-restli-protocol-version": "2.0.0",
          },
          credentials: "include",
        });
        if (!resp.ok) return JSON.stringify({ error: resp.status });
        return await resp.text();
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    })()
  `;
}

export function buildFetchConversations(
  csrfToken: string,
  mailboxUrn: string,
  nextCursor: string | null = null,
  category: InboxCategory = 'PRIMARY_INBOX',
  count = 20,
): string {
  const ids = getQueryIds();
  const encodedUrn = mailboxUrn.replace(/:/g, '%3A');
  let variables = `(query:(predicateUnions:List((conversationCategoryPredicate:(category:${category})))),count:${count},mailboxUrn:${encodedUrn}`;
  if (nextCursor) {
    variables += `,nextCursor:${encodeURIComponent(nextCursor)}`;
  }
  variables += ')';
  return messagingGraphQL(ids.messengerConversations, variables, csrfToken);
}

export function buildFetchMessages(csrfToken: string, conversationUrn: string): string {
  const ids = getQueryIds();
  const encodedUrn = conversationUrn
    .replace(/:/g, '%3A')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/,/g, '%2C')
    .replace(/=/g, '%3D');
  const variables = `(conversationUrn:${encodedUrn})`;
  return messagingGraphQL(ids.messengerMessages, variables, csrfToken);
}

export function buildFetchCurrentProfile(csrfToken: string): string {
  return voyagerFetch('/voyager/api/me', csrfToken);
}

export function buildFetchProfile(csrfToken: string, publicIdentifier: string): string {
  const endpoint =
    `/voyager/api/identity/dash/profiles?q=memberIdentity` +
    `&memberIdentity=${encodeURIComponent(publicIdentifier)}` +
    `&decorationId=${PROFILE_DECORATION_ID}`;
  return voyagerFetch(endpoint, csrfToken);
}

export type ProfileUpdatesOptions = {
  start?: number;
  paginationToken?: string | null;
  count?: number;
};

export function buildFetchProfileUpdates(
  csrfToken: string,
  profileUrn: string,
  opts: ProfileUpdatesOptions = {},
): string {
  const { start = 0, paginationToken = null, count = 20 } = opts;
  const encodedUrn = assertProfileUrn(profileUrn).replace(/:/g, '%3A');
  assertCount('count', count, { min: 1, max: 100 });
  assertCount('start', start, { min: 0, max: 100_000 });
  const safeToken = assertPaginationToken(paginationToken);
  let variables = `(count:${count},start:${start},profileUrn:${encodedUrn}`;
  if (safeToken) variables += `,paginationToken:${safeToken}`;
  variables += ')';
  const endpoint = `/voyager/api/graphql?variables=${variables}&queryId=${getQueryIds().profileUpdates}`;
  return voyagerFetch(endpoint, csrfToken);
}