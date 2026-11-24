import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readPendingProposals, writePendingProposals } from '../automation/core/pending.js';
import type { PendingProposal } from '../automation/comments/pipeline.js';
import { readDrafts, writeDrafts, type MessageDraft } from '../automation/messaging/queue.js';

export type ReviewServerOptions = {
  stateDir: string;
  host?: string;
  port: number;
};

export type ReviewServerHandle = {
  port: number;
  host: string;
  csrfTokenPath: string;
  token: string;
  close(): Promise<void>;
};

function csrfPath(stateDir: string): string {
  return join(stateDir, 'review-csrf.token');
}

export function readOrCreateCsrfToken(stateDir: string): string {
  const path = csrfPath(stateDir);
  if (existsSync(path)) return readFileSync(path, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function startReviewServer(opts: ReviewServerOptions): Promise<ReviewServerHandle> {
  if (opts.host !== undefined && opts.host !== '127.0.0.1') {
    throw new Error('review_server_loopback_only');
  }
  const host = '127.0.0.1';
  const token = readOrCreateCsrfToken(opts.stateDir);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/') {
      const proposals = readPendingProposals(opts.stateDir).filter((p) => p.status === 'pending' || p.status === 'approved');
      const drafts = readDrafts(opts.stateDir).filter((d) => d.status === 'pending');
      const html = `<!doctype html><html><head><title>Review queue</title></head><body>
<h1>Pending review</h1>
<h2>Comments</h2><ul>${proposals
        .map(
          (p) =>
            `<li>${escapeHtml(p.id)} — ${escapeHtml(p.text.slice(0, 120))} <form method="post" action="/action"><input type="hidden" name="kind" value="comment"/><input type="hidden" name="id" value="${escapeHtml(p.id)}"/><button name="action" value="approve">approve</button><button name="action" value="reject">reject</button></form></li>`,
        )
        .join('')}</ul>
<h2>Message drafts</h2><ul>${drafts
        .map(
          (d) =>
            `<li>${escapeHtml(d.id)} — ${escapeHtml(d.text.slice(0, 120))} <form method="post" action="/action"><input type="hidden" name="kind" value="draft"/><input type="hidden" name="id" value="${escapeHtml(d.id)}"/><button name="action" value="approve">approve</button><button name="action" value="reject">reject</button></form></li>`,
        )
        .join('')}</ul>
<p>Send header x-review-csrf with the token from review-csrf.token for POST /action.</p>
</body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/pending') {
      sendJson(res, 200, {
        comments: readPendingProposals(opts.stateDir),
        drafts: readDrafts(opts.stateDir),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/action') {
      const csrf = req.headers['x-review-csrf'];
      if (csrf !== token) {
        sendJson(res, 403, { error: 'csrf' });
        return;
      }
      const raw = await parseBody(req);
      const params = new URLSearchParams(raw);
      const action = params.get('action');
      const kind = params.get('kind');
      const id = params.get('id') ?? '';
      if (!action || !kind || !id) {
        sendJson(res, 400, { error: 'missing_fields' });
        return;
      }
      if (kind === 'comment') {
        const proposals = readPendingProposals(opts.stateDir);
        const idx = proposals.findIndex((p) => p.id === id);
        if (idx < 0) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        const current = proposals[idx]!;
        if (action === 'approve') {
          proposals[idx] = { ...current, status: 'approved' };
        } else if (action === 'reject') {
          proposals.splice(idx, 1);
        } else if (action === 'edit') {
          const text = params.get('text') ?? current.text;
          const newId = `${id}-edit-${randomBytes(4).toString('hex')}`;
          proposals.push({ ...current, id: newId, text, status: 'pending' });
        } else {
          sendJson(res, 400, { error: 'unknown_action' });
          return;
        }
        writePendingProposals(opts.stateDir, proposals);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (kind === 'draft') {
        let drafts = readDrafts(opts.stateDir);
        const idx = drafts.findIndex((d) => d.id === id);
        if (idx < 0) {
          sendJson(res, 404, { error: 'not_found' });
          return;
        }
        const current = drafts[idx]!;
        if (action === 'approve') {
          drafts[idx] = { ...current, status: 'approved' };
        } else if (action === 'reject') {
          drafts = drafts.filter((d) => d.id !== id);
        } else if (action === 'edit') {
          const text = params.get('text') ?? current.text;
          const newId = `${id}-edit-${randomBytes(4).toString('hex')}`;
          drafts.push({ ...current, id: newId, text, status: 'pending' });
        } else {
          sendJson(res, 400, { error: 'unknown_action' });
          return;
        }
        writeDrafts(opts.stateDir, drafts);
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 400, { error: 'unknown_kind' });
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        host,
        csrfTokenPath: csrfPath(opts.stateDir),
        token,
        close: () =>
          new Promise((r, j) => {
            server.close((err) => (err ? j(err) : r()));
          }),
      });
    });
  });
}