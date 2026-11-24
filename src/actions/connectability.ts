import type { ActionSession } from './types.js';
import { actionSleep, navigate } from './cdp-util.js';
import { verifyNameTokens } from './connectability-tokens.js';

export type ConnectabilityState =
  | 'connect'
  | 'follow'
  | 'pending'
  | 'message'
  | 'email_required'
  | 'unavailable';

export type ConnectabilityResult = {
  slug: string;
  expectedName?: string;
  state: ConnectabilityState;
  degree: string;
  detail: Record<string, unknown>;
};

export const CONNECTABILITY_PROBE_EXPR = `(async function(){
  var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms)})};
  function topCard(){ return document.querySelector('main section')||document.querySelector('main')||document.body; }
  function labels(){
    var root=topCard();
    var btns=Array.prototype.slice.call(root.querySelectorAll('button, a'));
    return btns.map(function(b){return (b.getAttribute('aria-label')||b.innerText||'').trim()}).filter(function(s){return s.length});
  }
  var pre=labels();
  var title=(document.querySelector('main h1')||{}).innerText||'';
  var hasConnectPrimary = pre.some(function(l){return /^Invite .+ to connect$/i.test(l)||/^Connect$/i.test(l)});
  var hasPending = pre.some(function(l){return /^Pending/i.test(l)||/^Withdraw/i.test(l)});
  var hasMessage = pre.some(function(l){return /^Message /i.test(l)||/^Message$/i.test(l)});
  var hasFollow  = pre.some(function(l){return /^Follow /i.test(l)||/^Follow$/i.test(l)});
  var emailGate = /email address to connect|enter their email/i.test(topCard().innerText||'');
  var degree=(topCard().innerText.match(/\\b(1st|2nd|3rd\\+?)\\b/)||[])[1]||'';
  var connectInMore=false, moreItems=[];
  if(!hasConnectPrimary && !hasPending){
    var moreBtn=Array.prototype.slice.call(topCard().querySelectorAll('button')).find(function(b){
      var l=(b.getAttribute('aria-label')||b.innerText||''); return /^More$/i.test(l)||/^More actions/i.test(l);
    });
    if(moreBtn){ moreBtn.click(); await sleep(400);
      moreItems=Array.prototype.slice.call(document.querySelectorAll('[role=menu] *, .artdeco-dropdown__content *'))
        .map(function(e){return (e.getAttribute&&e.getAttribute('aria-label')||e.innerText||'').trim()})
        .filter(function(s){return s.length&&s.length<60});
      connectInMore=moreItems.some(function(l){return /^Connect$/i.test(l)||/^Invite .+ to connect$/i.test(l)});
      document.body.click(); await sleep(200);
    }
  }
  return {title:title, degree:degree, labels:pre, hasConnectPrimary:hasConnectPrimary, connectInMore:connectInMore, hasPending:hasPending, hasMessage:hasMessage, hasFollow:hasFollow, emailGate:emailGate, moreItems:moreItems};
})()`;

function asStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === 'string');
}

function isConnectLabel(label: string, expectedName?: string): boolean {
  if (/disconnect/i.test(label)) return false;
  if (/^Connect$/i.test(label)) return true;
  const invite = /^Invite (.+) to connect$/i.exec(label);
  if (!invite) return false;
  if (!expectedName) return true;
  return verifyNameTokens(expectedName, invite[1] ?? '');
}

export function classifyConnectabilityProbe(
  probe: Record<string, unknown>,
  opts: { expectedName?: string },
): ConnectabilityState {
  const title = typeof probe['title'] === 'string' ? probe['title'] : '';
  if (opts.expectedName && !verifyNameTokens(opts.expectedName, title)) {
    return 'unavailable';
  }
  const labels = asStrings(probe['labels']);
  const moreItems = asStrings(probe['moreItems']);
  const hasPending = labels
    ? labels.some((label) => /^Pending/i.test(label) || /^Withdraw/i.test(label))
    : probe['hasPending'] === true;
  if (hasPending) return 'pending';
  const degree = typeof probe['degree'] === 'string' ? probe['degree'] : '';
  const hasMessage = labels
    ? labels.some((label) => /^Message( |$)/i.test(label))
    : probe['hasMessage'] === true;
  const hasConnectPrimary = labels
    ? labels.some((label) => isConnectLabel(label, opts.expectedName))
    : probe['hasConnectPrimary'] === true;
  const connectInMore = moreItems
    ? moreItems.some((label) => isConnectLabel(label, opts.expectedName))
    : probe['connectInMore'] === true;
  const hasFollow = labels
    ? labels.some((label) => /^Follow( |$)/i.test(label))
    : probe['hasFollow'] === true;
  const emailGate = probe['emailGate'] === true;
  if (emailGate) return 'email_required';
  if (degree === '1st' || (hasMessage && !hasConnectPrimary && !connectInMore)) return 'message';
  if (hasConnectPrimary || connectInMore) return 'connect';
  if (hasFollow && !hasConnectPrimary && !connectInMore) return 'follow';
  return 'unavailable';
}

export type ConnectabilityOptions = {
  slug: string;
  expectedName?: string;
  live?: boolean;
  session?: ActionSession;
  profileActions?: Record<string, unknown>;
};

export async function probeConnectability(opts: ConnectabilityOptions): Promise<ConnectabilityResult> {
  const slug = opts.slug.trim();
  if (!slug) throw new TypeError('slug required');
  if (opts.profileActions) {
    const actions = opts.profileActions;
    const state = classifyConnectabilityProbe(actions, opts);
    return {
      slug,
      expectedName: opts.expectedName,
      state,
      degree: typeof actions['degree'] === 'string' ? actions['degree'] : '',
      detail: actions,
    };
  }

  if (!opts.live) {
    return { slug, expectedName: opts.expectedName, state: 'unavailable', degree: '', detail: { dryRun: true } };
  }
  const session = opts.session;
  if (!session) throw new Error('session required');

  await navigate(session.cdp, `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`);
  await actionSleep(300);
  const raw = await session.evaluate(CONNECTABILITY_PROBE_EXPR);
  const probe = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const state = classifyConnectabilityProbe(probe, { expectedName: opts.expectedName });
  return {
    slug,
    expectedName: opts.expectedName,
    state,
    degree: typeof probe['degree'] === 'string' ? probe['degree'] : '',
    detail: probe,
  };
}
