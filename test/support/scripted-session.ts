import type { CdpSession } from '../../src/cdp/session.js';
import type { ActionSession } from '../../src/actions/types.js';

export type ScriptProfile = {
  composeReady?: boolean;
  commentPosted?: boolean;
  inviteResponse?: { status: number; body: string };
  inviteRequestPostData?: string;
  dialogText?: string;
  sentPageOk?: boolean;
};

export function createScriptedActionSession(profile: ScriptProfile, overrides: Partial<ActionSession> = {}): ActionSession {
  const cdp = {
    send: async (method: string) => {
      if (method === 'Page.captureScreenshot') return { data: '' };
      if (method === 'Network.enable') return {};
      if (method === 'Page.enable' || method === 'Page.navigate') return {};
      if (method === 'Network.getResponseBody') {
        return { body: profile.inviteResponse?.body ?? '{}' };
      }
      if (method === 'Network.getRequestPostData') {
        return { postData: profile.inviteRequestPostData ?? '' };
      }
      return {};
    },
    waitForEvent: async () => {},
    bringToFront: async () => {},
    close: () => {},
    onMessage: (h: (raw: string) => void) => {
      if (profile.inviteResponse) {
        setTimeout(() => {
          if (profile.inviteRequestPostData) {
            h(
              JSON.stringify({
                method: 'Network.requestWillBeSent',
                params: {
                  requestId: 'req-1',
                  request: {
                    method: 'POST',
                    url: 'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships',
                    postData: profile.inviteRequestPostData,
                  },
                },
              }),
            );
          }
          h(
            JSON.stringify({
              method: 'Network.responseReceived',
              params: {
                requestId: 'req-1',
                response: {
                  url: 'https://www.linkedin.com/voyager/api/voyagerRelationshipsDashMemberRelationships',
                  status: profile.inviteResponse!.status,
                },
              },
            }),
          );
        }, 5);
      }
    },
    offMessage: () => {},
    evaluate: async () => null,
    targetId: 'script',
    wsUrl: 'ws://script',
  } as unknown as CdpSession;

  const evaluate = async (expression: string): Promise<unknown> => {
    if (expression.includes('msg-form__contenteditable') && expression.includes('deadline')) {
      return profile.composeReady === false ? 'timeout' : 'ready';
    }
    if (expression.includes('msg-form__contenteditable') && expression.includes('no_compose_box')) {
      return JSON.stringify({ ok: profile.composeReady !== false });
    }
    if (expression.includes('msg-form__contenteditable') && expression.includes('dispatchEvent')) {
      return JSON.stringify({ ok: profile.composeReady !== false });
    }
    if (expression.includes('msg-form__send-button') && expression.includes('click')) {
      return JSON.stringify({ ok: profile.composeReady !== false });
    }
    if (expression.includes('msg-s-message-list__event')) {
      return JSON.stringify({ verified: profile.composeReady !== false });
    }
    if (expression.includes('postedCommentEvidence') || expression.includes('expandable-text-box')) {
      return JSON.stringify({ count: profile.commentPosted ? 1 : 0, matches: profile.commentPosted ? [{}] : [] });
    }
    if (expression.includes('data-linkedin-cdp-comment-editor') && expression.includes('insertText') === false) {
      if (expression.includes('editor_ambiguous')) return JSON.stringify({ ok: true, count: 1 });
      return JSON.stringify({ ok: true, count: 1 });
    }
    if (expression.includes('document.body.innerText') && expression.includes('8000')) {
      const dialog = profile.dialogText ?? 'Personalize your invitation to Jane Example by adding a note.';
      return JSON.stringify({ body: dialog, dialog });
    }
    if (expression.includes('document.body.innerText') && expression.includes('12000')) {
      return profile.dialogText ?? 'Personalize your invitation to Jane Example by adding a note.';
    }
    if (expression.includes('document.body.innerText') && expression.includes('People')) {
      const people = profile.sentPageOk !== false;
      const name = 'Jane Example';
      return JSON.stringify({
        people,
        body: people ? `People (2)\n${name}\nWithdraw\n` : 'No invites',
      });
    }
    if (expression.includes('Personalize your invitation')) {
      return profile.dialogText ?? 'Personalize your invitation to Jane Example by adding a note.';
    }
    if (expression.includes('readyState') && expression.includes('linkedin.com')) {
      return JSON.stringify({ ok: true, url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', title: 'Post' });
    }
    if (expression.includes('deadline') && expression.includes('linkedin.com')) {
      return JSON.stringify({ ok: true, url: 'https://www.linkedin.com/feed/update/urn:li:activity:1/', title: 'Post' });
    }
    if (expression.includes('JSESSIONID')) return 'csrf';
    if (expression.includes('deepAll') || expression.includes('Send without')) return true;
    if (expression.includes('split(value)')) return 0;
    if (expression.includes('activeElement')) return JSON.stringify({ ok: true });
    if (expression.includes('observed ===')) return JSON.stringify({ ok: true, observedLength: 10 });
    if (expression.includes('submit_ambiguous') || expression.includes('Comment')) {
      return JSON.stringify({ ok: true, depth: 2 });
    }
    return null;
  };

  return {
    cdp,
    evaluate,
    csrfToken: 'csrf',
    mailboxUrn: 'urn:li:fsd_profile:EXAMPLE',
    publicIdentifier: 'example-user',
    displayName: 'Example User',
    ...overrides,
  };
}