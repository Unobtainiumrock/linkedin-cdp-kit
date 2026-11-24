import {
  RELATIONSHIPS_POST_PATH,
  classifyInviteResponse,
  customInviteUrl,
  recipientDialogMatches,
} from './classify-invite.js';
import type { ActionSession, InviteCandidateInput, InviteSendOpts, VerifySentResult } from './types.js';
import { SHADOW_HELPERS, awaitNetworkResponse, getResponseBody, navigate, actionSleep, enablePage } from './cdp-util.js';

export type ConnectionInviteResult =
  | { status: 'dry_run'; url: string; recipientName: string }
  | { status: 'sent'; invitationUrn: string }
  | { status: 'rejected_limit' | 'rejected_resend' | 'recipient_name_mismatch' | 'email_required' | 'already_pending' | 'already_connected' | 'unavailable' | 'security_warning' | 'uncertain' | 'manual_review'; detail?: string };

export type InviteFailureStatus = Exclude<ConnectionInviteResult['status'], 'sent' | 'dry_run'>;

const LIMIT_RE = /weekly invitation limit|invitation limit reached|too many invitations/i;
const WARNING_RE = /temporarily restricted|unusual activity|security verification|captcha/i;

export async function inspectInviteSurface(session: ActionSession, dialogText: string, candidate: InviteCandidateInput): Promise<InviteFailureStatus | 'ready'> {
  const raw = await session.evaluate(`(() => {
    return JSON.stringify({ body: document.body.innerText.slice(0, 8000), dialog: ${JSON.stringify(dialogText)} });
  })()`);
  const { body } = JSON.parse(String(raw)) as { body: string };
  if (LIMIT_RE.test(body)) return 'rejected_limit';
  if (WARNING_RE.test(body)) return 'security_warning';
  if (/enter their email|email address to connect/i.test(body)) return 'email_required';
  if (/\bPending\b/.test(body) && !dialogText) return 'already_pending';
  if (/already connected|already a connection/i.test(body)) return 'already_connected';
  if (!dialogText) return 'unavailable';
  return recipientDialogMatches(candidate.recipientName, dialogText, candidate.inviteName) ? 'ready' : 'recipient_name_mismatch';
}

async function readDialogText(session: ActionSession): Promise<string> {
  const raw = await session.evaluate(`(() => document.body.innerText.slice(0, 12000))()`);
  return String(raw ?? '');
}

async function clickProfileConnect(session: ActionSession, candidate: InviteCandidateInput): Promise<'clicked' | 'not_found'> {
  const namePayload = JSON.stringify(candidate.recipientName);
  const raw = await session.evaluate(`(() => {
    ${SHADOW_HELPERS}
    const title = document.title || '';
    const tokens = ${namePayload}.toLowerCase().split(/\\s+/).filter(Boolean);
    const titleOk = tokens.length && tokens.every(t => title.toLowerCase().includes(t));
  const candidates = deepAll(function(e){
      if (e.tagName !== 'BUTTON') return false;
      const lab = label(e);
      if (!/^Connect$/i.test(lab) && !/^Connect$/i.test(aria(e))) return false;
      if (!vis(e)) return false;
      const al = (e.getAttribute && e.getAttribute('aria-label')) || '';
      if (al && tokens.length && !tokens.every(t => al.toLowerCase().includes(t))) return false;
      return true;
    });
    if (!titleOk && candidates.length > 1) return JSON.stringify({ ok: false, reason: 'sidebar_contamination' });
    let btn = candidates[0];
    if (!btn) {
      const more = deepAll(function(e){ return e.tagName==='BUTTON' && /^More$/i.test(label(e)) && vis(e); })[0];
      if (more) { more.click(); }
      btn = deepAll(function(e){
        return e.tagName==='BUTTON' && /^Connect$/i.test(label(e)) && vis(e);
      })[0];
    }
    if (!btn) return JSON.stringify({ ok: false, reason: 'connect_not_found' });
    btn.click();
    return JSON.stringify({ ok: true });
  })()`);
  const parsed = JSON.parse(String(raw)) as { ok: boolean; reason?: string };
  return parsed.ok ? 'clicked' : 'not_found';
}

async function clickInviteInModal(session: ActionSession, note?: string): Promise<void> {
  const notePayload = JSON.stringify(note ?? '');
  await session.evaluate(`(async () => {
    ${SHADOW_HELPERS}
    var ms = (function(){
      var addNote=deepAll(function(e){return e.tagName=='BUTTON'&&/^Add a note$/i.test(label(e))&&vis(e);})[0];
      var sendNoNote=deepAll(function(e){return e.tagName=='BUTTON'&&/^Send without a note$/i.test(label(e))&&vis(e);})[0];
      return {addNote:!!addNote, sendNoNote:!!sendNoNote};
    })();
  var note = ${notePayload};
  if (note && ms.addNote) {
    deepAll(function(e){return e.tagName=='BUTTON'&&/^Add a note$/i.test(label(e))&&vis(e);})[0]?.click();
    await new Promise(r=>setTimeout(r,700));
    var ta=deepAll(function(e){return e.tagName=='TEXTAREA'&&vis(e);})[0];
    if (ta) { ta.value = note; ta.dispatchEvent(new Event('input',{bubbles:true})); }
    var s=deepAll(function(e){return e.tagName=='BUTTON'&&/^(Send|Send invitation|Send now)$/i.test(label(e))&&vis(e);})[0];
    if (s) s.click();
  } else {
    var s2=deepAll(function(e){return e.tagName=='BUTTON'&&/^Send without a note$/i.test(label(e))&&vis(e);})[0];
    if (s2) s2.click();
  }
  return true;
  })()`);
}

export async function sendConnectionInviteLive(
  session: ActionSession,
  candidate: InviteCandidateInput,
  opts: InviteSendOpts = {},
): Promise<ConnectionInviteResult> {
  const url = customInviteUrl(candidate.vanityName);
  if (!opts.live) return { status: 'dry_run', url, recipientName: candidate.recipientName };

  await enablePage(session.cdp);
  await navigate(session.cdp, url);
  await actionSleep(2_000);
  let dialogText = await readDialogText(session);
  let inspect = await inspectInviteSurface(session, dialogText, candidate);
  if (inspect === 'unavailable' && opts.useProfileFallback) {
    await navigate(session.cdp, `https://www.linkedin.com/in/${candidate.vanityName}/`);
    await actionSleep(2_000);
    const clicked = await clickProfileConnect(session, candidate);
    if (clicked === 'not_found') return { status: 'unavailable', detail: 'profile_connect_missing' };
    dialogText = await readDialogText(session);
    inspect = await inspectInviteSurface(session, dialogText, candidate);
  }
  if (inspect !== 'ready') return { status: inspect, detail: inspect === 'uncertain' ? 'preflight' : inspect };

  const capture = await awaitNetworkResponse(session.cdp, RELATIONSHIPS_POST_PATH, async () => {
    await clickInviteInModal(session, candidate.note);
  });

  if (!capture) {
    dialogText = await readDialogText(session);
    const post = await inspectInviteSurface(session, dialogText, candidate);
    if (post === 'rejected_limit') return { status: 'rejected_limit' };
    return { status: 'uncertain', detail: 'no_network_response' };
  }

  const bodyText = await getResponseBody(session.cdp, capture.requestId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 'uncertain', detail: 'bad_json' };
  }

  dialogText = await readDialogText(session);
  if (!recipientDialogMatches(candidate.recipientName, dialogText, candidate.inviteName)) {
    return { status: 'recipient_name_mismatch' };
  }

  const classified = classifyInviteResponse(capture.status, parsed);
  if (classified.result === 'rejected_limit') return { status: 'rejected_limit' };
  if (classified.result === 'rejected_resend') return { status: 'rejected_resend' };
  if (classified.result === 'sent' && classified.value) {
    const urn = classified.value['invitationUrn'];
    if (typeof urn === 'string') {
      if (candidate.expectedProfileUrn) {
        const reqRaw = await session.evaluate(`(() => null)()`);
        void reqRaw;
        const bodyStr = bodyText;
        if (candidate.expectedProfileUrn && !bodyStr.includes(candidate.expectedProfileUrn.split(':').pop() || '')) {
          const invitee = classified.value['inviteeUrn'];
          if (typeof invitee === 'string' && invitee !== candidate.expectedProfileUrn) {
            return { status: 'uncertain', detail: 'urn_mismatch' };
          }
        }
      }
      return { status: 'sent', invitationUrn: urn };
    }
  }
  return { status: 'uncertain' };
}

export async function verifySentInvites(session: ActionSession, recipientName: string): Promise<VerifySentResult> {
  const tokens = recipientName.toLowerCase().split(/\s+/).filter(Boolean);
  const last = tokens[tokens.length - 1] || recipientName;
  await navigate(session.cdp, 'https://www.linkedin.com/mynetwork/invitation-manager/sent/');
  await actionSleep(2_000);
  const raw = await session.evaluate(`(() => {
    const fn = () => /People\\s*\\(?\\d/.test(document.body.innerText);
    return JSON.stringify({
      people: fn(),
      body: document.body.innerText.slice(0, 15000),
    });
  })()`);
  const data = JSON.parse(String(raw)) as { people: boolean; body: string };
  const body = data.body || '';
  const recipientVisible = tokens.every((t) => body.toLowerCase().includes(t)) || body.toLowerCase().includes(last.toLowerCase());
  const withdrawVisible = /withdraw/i.test(body);
  const ok = data.people && recipientVisible && withdrawVisible;
  return {
    ok,
    peopleLabelFound: data.people,
    recipientVisible,
    withdrawVisible,
    detail: ok ? undefined : 'sent_page_verification_failed',
  };
}

export { RELATIONSHIPS_POST_PATH, customInviteUrl, classifyInviteResponse, recipientDialogMatches };

export function parseRelationshipsIntercept(
  status: number,
  bodyText: string,
  dialogText: string,
  recipientName: string,
  inviteName?: string,
): ConnectionInviteResult {
  if (!recipientDialogMatches(recipientName, dialogText, inviteName)) {
    return { status: 'recipient_name_mismatch' };
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { status: 'uncertain', detail: 'unparseable_response_body' };
  }
  const classified = classifyInviteResponse(status, body);
  if (classified.result === 'sent' && classified.value) {
    const urn = classified.value['invitationUrn'];
    if (typeof urn === 'string') return { status: 'sent', invitationUrn: urn };
  }
  if (classified.result === 'rejected_limit') return { status: 'rejected_limit' };
  if (classified.result === 'rejected_resend') return { status: 'rejected_resend' };
  return { status: 'uncertain' };
}