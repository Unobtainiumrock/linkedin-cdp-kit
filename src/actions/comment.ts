import { writeFile } from 'node:fs/promises';
import type { ActionSession } from './types.js';
import { COMMENT_POLL_SETTLE, COMMENT_TYPE_SETTLE, focusForInput, inputInsertText, navigate, settleDelay, enablePage, type SettleRange } from './cdp-util.js';

export type CommentInput = { postUrl: string; text: string };

export function validateCommentInput(postUrl: string, text: string): CommentInput {
  let parsed: URL;
  try {
    parsed = new URL(postUrl);
  } catch {
    throw new TypeError('postUrl must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(parsed.hostname.toLowerCase())) {
    throw new TypeError('postUrl must use https://www.linkedin.com');
  }
  if (!parsed.pathname.startsWith('/posts/') && !parsed.pathname.startsWith('/feed/update/')) {
    throw new TypeError('postUrl must identify a LinkedIn post');
  }
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('comment text is required');
  if ([...text.trim()].length > 1250) throw new TypeError('comment text exceeds 1250 characters');
  parsed.hash = '';
  return { postUrl: parsed.toString(), text: text.trim() };
}

export type EditorNodeLike = {
  nodeType: number;
  nodeName: string;
  textContent?: string | null;
  childNodes?: Iterable<EditorNodeLike>;
  classList?: { contains(name: string): boolean };
};

export type EditorLike = { childNodes?: Iterable<EditorNodeLike> };

export function editorTextFromDom(editor: EditorLike): string {
  function read(node: EditorNodeLike): string {
    if (node.nodeType === 3) return node.textContent || '';
    if (node.nodeName === 'BR') return node.classList?.contains('ProseMirror-trailingBreak') ? '' : '\n';
    return [...(node.childNodes || [])].map(read).join('');
  }
  return [...(editor.childNodes || [])]
    .map(read)
    .join('\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

/** Serializable for Runtime.evaluate injection */
export const editorTextSource = editorTextFromDom.toString();

export const postedCommentEvidenceSource = `function postedCommentEvidence(text, profileSlug) {
  const normalize = value => value.replace(/\\s+/g, ' ').trim();
  const expected = normalize(text);
  const boxes = [...document.querySelectorAll('main [data-testid="expandable-text-box"], main .comments-comment-item__main-content')];
  const matches = [];
  for (const box of boxes) {
    if (box.closest('[contenteditable="true"]')) continue;
    const clone = box.cloneNode(true);
    clone.querySelectorAll('button').forEach(button => button.remove());
    clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\\n')));
    if (normalize(clone.textContent || '') !== expected) continue;
    let scope = box;
    for (let depth = 0; scope && depth < 8 && scope.tagName !== 'MAIN'; depth++, scope = scope.parentElement) {
      const author = [...scope.querySelectorAll('a[href]')].find(a => {
        try { return new URL(a.href).pathname.replace(/\\/$/, '') === '/in/' + profileSlug; } catch { return false; }
      });
      if (author) { matches.push({ authorUrl: author.href, text: clone.textContent }); break; }
    }
  }
  return { count: matches.length, matches };
}`;

export type CommentLiveResult = {
  ok: boolean;
  status: 'dry_run_completed' | 'posted' | 'manual_review' | 'retry';
  postUrl: string;
  error?: { code: string; message: string };
  receipt: Record<string, unknown>;
};

async function waitForPostPage(evaluate: ActionSession['evaluate'], timeoutMs = 35_000) {
  const raw = await evaluate(
    `(async () => {
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline) {
        const url = location.href;
        if (/\\/(checkpoint|login|authwall|uas\\/login)\\b/i.test(url)) {
          return JSON.stringify({ ok: false, reason: "authwall", url });
        }
        if ((document.readyState === "interactive" || document.readyState === "complete") &&
            url.startsWith("https://www.linkedin.com/")) {
          await new Promise((resolve) => setTimeout(resolve, 1800));
          return JSON.stringify({ ok: true, url, title: document.title });
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return JSON.stringify({ ok: false, reason: "page_timeout", url: location.href });
    })()`,
    timeoutMs + 5_000,
  );
  return JSON.parse(String(raw)) as { ok: boolean; reason?: string; url?: string; title?: string };
}

async function locateEditor(evaluate: ActionSession['evaluate']) {
  const raw = await evaluate(`(async () => {
    const visible = (element) => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" &&
        style.opacity !== "0" && box.width > 0 && box.height > 0;
    };
    const selectors = [
      'main [contenteditable="true"][role="textbox"][aria-label*="comment" i]',
      'main [contenteditable="true"][data-placeholder*="comment" i]',
      'main .comments-comment-box [contenteditable="true"][role="textbox"]'
    ];
    let editors = [];
    for (const selector of selectors) {
      editors = [...document.querySelectorAll(selector)].filter(visible);
      if (editors.length) break;
    }
    if (!editors.length) {
      const buttons = [...document.querySelectorAll('main button')].filter((button) => {
        const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
        return visible(button) && /^comment\\b/i.test(label);
      });
      if (buttons.length === 1) { buttons[0].click(); await new Promise((r) => setTimeout(r, 800)); }
      editors = [...document.querySelectorAll('main [contenteditable="true"][role="textbox"]')].filter(visible);
    }
    if (editors.length !== 1) return JSON.stringify({ ok: false, reason: "editor_ambiguous", count: editors.length });
    editors[0].setAttribute("data-linkedin-cdp-comment-editor", "true");
    return JSON.stringify({ ok: true, count: 1 });
  })()`);
  return JSON.parse(String(raw)) as { ok: boolean; reason?: string; count?: number };
}

async function fillEditor(session: ActionSession, text: string, settle: SettleRange = COMMENT_TYPE_SETTLE) {
  const ready = JSON.parse(
    String(
      await session.evaluate(`(() => {
    const editor = document.querySelector('[data-linkedin-cdp-comment-editor="true"]');
    if (!editor) return JSON.stringify({ ok: false, reason: "editor_missing" });
    if (editor.textContent.trim()) return JSON.stringify({ ok: false, reason: "editor_has_existing_draft" });
    editor.focus();
    return JSON.stringify({ ok: document.activeElement === editor });
  })()`),
    ),
  ) as { ok: boolean; reason?: string };
  if (!ready.ok) return ready;
  await inputInsertText(session.cdp, text);
  await settleDelay(settle);
  return JSON.parse(
    String(
      await session.evaluate(`(() => {
    const editor = document.querySelector('[data-linkedin-cdp-comment-editor="true"]');
    if (!editor) return JSON.stringify({ ok: false, reason: "editor_missing" });
    const observed = (${editorTextSource})(editor);
    return JSON.stringify({ ok: observed === ${JSON.stringify(text)}, observedLength: observed.length });
  })()`),
    ),
  ) as { ok: boolean; reason?: string };
}

async function visibleTextCount(evaluate: ActionSession['evaluate'], text: string): Promise<number> {
  const payload = JSON.stringify(text);
  const n = await evaluate(
    `(() => {
    const value = ${payload};
    return value ? (document.body?.innerText || "").split(value).length - 1 : 0;
  })()`,
  );
  return Number(n);
}

async function clickSubmit(evaluate: ActionSession['evaluate']) {
  const raw = await evaluate(`(() => {
    const editor = document.querySelector('[data-linkedin-cdp-comment-editor="true"]');
    if (!editor) return JSON.stringify({ ok: false, reason: "editor_missing" });
    const visible = (element) => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    let scope = editor;
    for (let depth = 0; scope && depth < 10; depth += 1, scope = scope.parentElement) {
      const buttons = [...scope.querySelectorAll("button")].filter((button) => {
        const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
        return visible(button) && !button.disabled && /^(comment|post|post comment)$/i.test(label);
      });
      if (buttons.length === 1) {
        buttons[0].scrollIntoView({ block: "center" });
        buttons[0].click();
        return JSON.stringify({ ok: true, depth });
      }
    }
    return JSON.stringify({ ok: false, reason: "submit_ambiguous" });
  })()`);
  return JSON.parse(String(raw)) as { ok: boolean; reason?: string };
}

async function screenshot(cdp: ActionSession['cdp'], path?: string) {
  if (!path) return;
  const result = (await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 20_000)) as {
    data?: string;
  };
  if (result.data) await writeFile(path, Buffer.from(result.data, 'base64'), { mode: 0o600 });
}

export type CommentOnPostOptions = {
  live?: boolean;
  expectedProfileSlug?: string;
  screenshotPath?: string;
  settle?: SettleRange;
  pollSettle?: SettleRange;
};

export async function commentOnPostLive(
  session: ActionSession,
  postUrl: string,
  text: string,
  opts: CommentOnPostOptions = {},
): Promise<CommentLiveResult> {
  const input = validateCommentInput(postUrl, text);
  const result: CommentLiveResult = {
    ok: false,
    status: 'retry',
    postUrl: input.postUrl,
    receipt: {},
  };
  let phase: 'pre_click' | 'clicking' | 'post_click' = 'pre_click';
  try {
    await enablePage(session.cdp);
    await focusForInput(session.cdp);
    await navigate(session.cdp, input.postUrl);
    const page = await waitForPostPage(session.evaluate);
    if (!page.ok) throw new Error(page.reason || 'page_load_failed');
    const editor = await locateEditor(session.evaluate);
    if (!editor.ok) throw new Error(`${editor.reason}:${editor.count}`);
    result.receipt = { targetUrl: page.url, title: page.title, commentBoxReady: true, observedAt: new Date().toISOString() };
    if (!opts.live) {
      await screenshot(session.cdp, opts.screenshotPath);
      result.ok = true;
      result.status = 'dry_run_completed';
      return result;
    }
    const before = await visibleTextCount(session.evaluate, input.text);
    if (before > 0) {
      result.status = 'manual_review';
      result.error = { code: 'duplicate_text_visible', message: 'Exact comment text already on page' };
      return result;
    }
    const filled = await fillEditor(session, input.text, opts.settle ?? COMMENT_TYPE_SETTLE);
    if (!filled.ok) throw new Error(filled.reason || 'comment_text_not_retained');
    phase = 'clicking';
    const clicked = await clickSubmit(session.evaluate);
    if (!clicked.ok) throw new Error(clicked.reason || 'comment_submit_not_found');
    phase = 'post_click';
    const slug = opts.expectedProfileSlug || session.publicIdentifier || '';
    const fast = process.env['LINKEDIN_CDP_FAST_NAV'] === '1';
    const deadline = Date.now() + (fast ? 50 : 15_000);
    const poll = opts.pollSettle ?? COMMENT_POLL_SETTLE;
    while (Date.now() < deadline) {
      await settleDelay(poll);
      const evidence = JSON.parse(
        String(
          await session.evaluate(
            `JSON.stringify((${postedCommentEvidenceSource})(${JSON.stringify(input.text)}, ${JSON.stringify(slug)}))`,
          ),
        ),
      ) as { count: number };
      if (evidence.count === 1) {
        result.ok = true;
        result.status = 'posted';
        result.receipt.uiVerified = true;
        await screenshot(session.cdp, opts.screenshotPath);
        return result;
      }
    }
    result.status = 'manual_review';
    result.error = { code: 'post_unverified', message: 'Submit clicked but comment not verified' };
    await screenshot(session.cdp, opts.screenshotPath);
    return result;
  } catch (err) {
    result.status = phase === 'pre_click' ? 'retry' : 'manual_review';
    result.error = {
      code: 'linkedin_interaction_failed',
      message: String(err instanceof Error ? err.message : err).slice(0, 2_000),
    };
    result.receipt.phase = phase;
    return result;
  }
}

export async function commentOnPost(
  session: ActionSession | null,
  postUrl: string,
  text: string,
  opts: CommentOnPostOptions = {},
): Promise<CommentLiveResult> {
  if (!opts.live) {
    const input = validateCommentInput(postUrl, text);
    return { ok: true, status: 'dry_run_completed', postUrl: input.postUrl, receipt: { dryRun: true } };
  }
  if (!session) {
    return {
      ok: false,
      status: 'manual_review',
      postUrl,
      error: { code: 'missing_session', message: 'no session' },
      receipt: {},
    };
  }
  return commentOnPostLive(session, postUrl, text, opts);
}