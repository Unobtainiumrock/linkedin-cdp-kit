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
  function labels(){
    var btns=Array.prototype.slice.call(document.querySelectorAll('main button, main a'));
    return btns.map(function(b){return (b.getAttribute('aria-label')||b.innerText||'').trim()}).filter(function(s){return s.length});
  }
  var pre=labels();
  var title=(document.querySelector('main h1')||{}).innerText||'';
  var hasConnectPrimary = pre.some(function(l){return /^Invite .* to connect$/i.test(l)||/^Connect$/i.test(l)});
  var hasPending = pre.some(function(l){return /^Pending/i.test(l)||/Withdraw/i.test(l)});
  var hasMessage = pre.some(function(l){return /^Message /i.test(l)||/^Message$/i.test(l)});
  var hasFollow  = pre.some(function(l){return /^Follow /i.test(l)||/^Follow$/i.test(l)});
  var emailGate = pre.some(function(l){return /email/i.test(l)});
  var degree=(document.body.innerText.match(/\\b(1st|2nd|3rd\\+?)\\b/)||[])[1]||'';
  var connectInMore=false, moreItems=[];
  if(!hasConnectPrimary && !hasPending){
    var moreBtn=Array.prototype.slice.call(document.querySelectorAll('main button')).find(function(b){
      var l=(b.getAttribute('aria-label')||b.innerText||''); return /^More/i.test(l)||/More actions/i.test(l);
    });
    if(moreBtn){ moreBtn.click(); await sleep(400);
      moreItems=Array.prototype.slice.call(document.querySelectorAll('[role=menu] *, .artdeco-dropdown__content *'))
        .map(function(e){return (e.getAttribute&&e.getAttribute('aria-label')||e.innerText||'').trim()})
        .filter(function(s){return s.length&&s.length<60});
      connectInMore=moreItems.some(function(l){return /connect/i.test(l)});
      document.body.click(); await sleep(200);
    }
  }
  return {title:title, degree:degree, labels:pre, hasConnectPrimary, connectInMore, hasPending, hasMessage, hasFollow, emailGate, moreItems};
})()`;

export function classifyConnectabilityProbe(
  probe: Record<string, unknown>,
  opts: { expectedName?: string },
): ConnectabilityState {
  const title = typeof probe['title'] === 'string' ? probe['title'] : '';
  if (opts.expectedName && title && !verifyNameTokens(opts.expectedName, title)) {
    return 'unavailable';
  }
  const hasPending = probe['hasPending'] === true;
  if (hasPending) return 'pending';
  const degree = typeof probe['degree'] === 'string' ? probe['degree'] : '';
  const hasMessage = probe['hasMessage'] === true;
  const hasConnectPrimary = probe['hasConnectPrimary'] === true;
  const connectInMore = probe['connectInMore'] === true;
  const hasFollow = probe['hasFollow'] === true;
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
    const state = typeof actions['state'] === 'string' ? (actions['state'] as ConnectabilityState) : classifyConnectabilityProbe(actions, opts);
    return {
      slug,
      expectedName: opts.expectedName,
      state,
      degree: typeof actions['degree'] === 'string' ? actions['degree'] : '',
      detail: actions,
    };
  }

  if (!opts.live) {
    return { slug, expectedName: opts.expectedName, state: 'connect', degree: '2nd', detail: { dryRun: true } };
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
