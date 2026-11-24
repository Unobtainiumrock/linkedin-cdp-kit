#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LinkedInSession } from '../src/session.js';
import { SessionLinkedInActions } from '../src/actions/session-actions.js';
import { FileStore } from '../src/automation/core/store.js';
import { runInvites, inviteStatus, resumeInvites } from '../src/automation/invites/runner.js';
import { DEFAULT_INVITE_CONFIG } from '../src/automation/invites/config.js';
import { loadHooksModule } from '../src/cli/hooks.js';
import { readPendingProposals, writePendingProposals } from '../src/automation/core/pending.js';
import { approveProposal, runCommentExecutor, type PendingProposal } from '../src/automation/comments/pipeline.js';
import { readDrafts, writeDrafts, type MessageDraft } from '../src/automation/messaging/queue.js';
import { dispatchOne } from '../src/automation/messaging/dispatch.js';
import { asPipelineStore } from '../src/pipeline/persist.js';
import { runRefill, JsonFileSource, CsvFileSource, type InviteQueueEntry } from '../src/pipeline/discovery.js';
import { runVerify, DEFAULT_PROFILE_VERIFIER_CONFIG } from '../src/pipeline/verify.js';
import { defaultScoreGrader } from '../src/pipeline/grading.js';
import { importConnectionsCsv, listContacts } from '../src/pipeline/contacts.js';
import { auditUnavailable, applyUnavailableAudit } from '../src/pipeline/audit.js';
import { evaluateHealth } from '../src/pipeline/health.js';
import { loadStrategyFromJson } from '../src/pipeline/strategy.js';
import { captureGraphqlQueryIds } from '../src/tools/capture-query-ids.js';
import { scrapeConnections } from '../src/actions/scrape-connections.js';

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const live = argv.includes('--live');
const cdpUrl = flag('--cdp-url');
const stateDir = flag('--state-dir') ?? join(process.cwd(), '.linkedin-cdp-state');
const hooksPath = flag('--hooks');
const expectedAccountId = flag('--expected-account');

async function connectActionsLive(): Promise<SessionLinkedInActions> {
  return connectActions(expectedAccountId ? { publicIdentifier: expectedAccountId } : undefined);
}

async function connectActions(expectedAccount?: { publicIdentifier?: string }): Promise<SessionLinkedInActions> {
  if (!cdpUrl) throw new Error('--cdp-url is required for live reads/writes');
  const li = new LinkedInSession();
  await li.connect({ cdpUrl, expectedAccount });
  return new SessionLinkedInActions(li);
}

async function main(): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const store = asPipelineStore(new FileStore({ rootDir: stateDir }));
  const domain = argv[0];

  if (domain === 'refill') {
    const jsonPath = flag('--json');
    const csvPath = flag('--csv');
    const strategyPath = flag('--strategy');
    const sources = [];
    if (jsonPath) sources.push(new JsonFileSource('json', jsonPath));
    if (csvPath) sources.push(new CsvFileSource('csv', csvPath));
    if (sources.length === 0) throw new Error('refill requires --json and/or --csv');
    const strategy = strategyPath ? loadStrategyFromJson(strategyPath) : undefined;
    console.log(JSON.stringify(await runRefill(store, sources, { strategy }), null, 2));
    return;
  }

  if (domain === 'verify') {
    const actions = live ? await connectActionsLive() : undefined;
    console.log(
      JSON.stringify(
        await runVerify(store, actions, defaultScoreGrader(0.3), { live, config: DEFAULT_PROFILE_VERIFIER_CONFIG }),
        null,
        2,
      ),
    );
    if (actions) await actions.linkedInSession.close();
    return;
  }

  if (domain === 'contacts') {
    const sub = argv[1];
    if (sub === 'import-csv') {
      const file = argv[2];
      if (!file) throw new Error('contacts import-csv <file>');
      console.log(JSON.stringify(importConnectionsCsv(store, file), null, 2));
      return;
    }
    if (sub === 'list') {
      const state = flag('--state');
      console.log(JSON.stringify(listContacts(store, state ? { state: state as 'connected' } : undefined), null, 2));
      return;
    }
    throw new Error('contacts: import-csv <file> | list [--state]');
  }

  if (domain === 'audit-unavailable') {
    const file = flag('--probes');
    if (!file) throw new Error('audit-unavailable --probes <json>');
    const probes = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      { status: number; redirectSlug?: string }
    >;
    const report = auditUnavailable(listContacts(store), probes);
    if (argv.includes('--apply')) console.log(JSON.stringify(applyUnavailableAudit(store, report), null, 2));
    else console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (domain === 'doctor') {
    console.log(JSON.stringify(evaluateHealth(store), null, 2));
    return;
  }

  if (domain === 'invites') {
    const sub = argv[1];
    if (sub === 'status') {
      console.log(JSON.stringify(inviteStatus(store), null, 2));
      return;
    }
    if (sub === 'resume') {
      resumeInvites(store, flag('--reason') ?? 'operator');
      console.log(JSON.stringify(store.readState(), null, 2));
      return;
    }
    if (sub === 'run') {
      const hooks = hooksPath ? await loadHooksModule(hooksPath) : {};
      const actions = live ? await connectActionsLive() : undefined;
      const qualified = store.readJson<InviteQueueEntry[]>('invite-qualified.json', []);
      const report = await runInvites({
        store,
        source: qualified.map((q) => ({ slug: q.slug, name: q.name })),
        actions,
        qualify: hooks.qualify,
        sendInvite: async (c, isLive) =>
          actions
            ? actions.sendConnectionInvite(
                { vanityName: c.slug, recipientName: c.name, note: c.note },
                { live: isLive },
              )
            : { status: 'dry_run', url: '', recipientName: c.name },
        config: { ...DEFAULT_INVITE_CONFIG, dryRun: !live },
      });
      if (actions) await actions.linkedInSession.close();
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    throw new Error('invites: status | run [--live] | resume --reason');
  }

  if (domain === 'comments') {
    const sub = argv[1];
    if (sub === 'list') {
      console.log(JSON.stringify(readPendingProposals(stateDir), null, 2));
      return;
    }
    if (sub === 'capture') {
      const slug = argv[2] ?? flag('--slug');
      if (!slug) throw new Error('comments capture <slug> [--cdp-url]');
      if (!live) {
        console.log(JSON.stringify({ dryRun: true, slug }));
        return;
      }
      const actions = await connectActionsLive();
      const profile = await actions.fetchProfile(slug, { posts: true });
      console.log(JSON.stringify({ slug, posts: profile.posts?.length ?? 0 }, null, 2));
      await actions.linkedInSession.close();
      return;
    }
    if (sub === 'approve') {
      const id = argv[2];
      const text = flag('--text');
      if (!id || !text) throw new Error('comments approve <id> --text');
      console.log(JSON.stringify({ ok: approveProposal(store, id, text) }));
      const pending = readPendingProposals(stateDir).map((p) => (p.id === id ? { ...p, status: 'approved' as const } : p));
      writePendingProposals(stateDir, pending);
      return;
    }
    if (sub === 'reject') {
      const id = argv[2];
      if (!id) throw new Error('comments reject <id>');
      store.appendLedger({ status: 'rejected', draftId: id });
      writePendingProposals(stateDir, readPendingProposals(stateDir).filter((p) => p.id !== id));
      return;
    }
    if (sub === 'run') {
      const proposals = readPendingProposals(stateDir).filter((p) => p.status === 'approved') as PendingProposal[];
      if (!live) {
        console.log(JSON.stringify({ dryRun: true, count: proposals.length }));
        return;
      }
      const actions = await connectActionsLive();
      const report = await runCommentExecutor(
        store,
        proposals,
        { dryRun: false, approvalPolicy: 'manual', circuitBreakerThreshold: 2, freshnessHours: 48, maxPerDay: 5, minGapMs: 7_200_000, maxGapMs: 7_300_000 },
        async ({ postUrl, text }) => {
          const r = await actions.commentOnPost(postUrl, text, { live: true, expectedProfileSlug: undefined });
          return { status: r.status };
        },
      );
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    throw new Error('comments: list | approve <id> --text | reject <id> | run [--live]');
  }

  if (domain === 'messaging') {
    const sub = argv[1];
    if (sub === 'list') {
      console.log(JSON.stringify(readDrafts(stateDir), null, 2));
      return;
    }
    if (sub === 'ingest') {
      if (!cdpUrl) throw new Error('--cdp-url required');
      const actions = await connectActionsLive();
      const convos = await actions.listConversations({ days: Number(flag('--days') ?? '14') });
      console.log(JSON.stringify({ count: convos.length, dryRun: !live }));
      return;
    }
    if (sub === 'approve') {
      const id = flag('--id');
      const text = flag('--text');
      if (!id || !text) throw new Error('messaging approve --id --text');
      const drafts = readDrafts(stateDir).map((d) => (d.id === id ? { ...d, status: 'approved' as const, text } : d));
      writeDrafts(stateDir, drafts);
      return;
    }
    if (sub === 'reject' || sub === 'edit') {
      const id = flag('--id');
      if (!id) throw new Error(`messaging ${sub} --id`);
      const drafts = readDrafts(stateDir).filter((d) => d.id !== id);
      if (sub === 'edit') {
        const text = flag('--text');
        if (!text) throw new Error('messaging edit --id --text');
        drafts.push({ id, conversationUrn: flag('--urn') ?? '', inboundFp: 'edited', text, status: 'pending', createdAt: new Date().toISOString() });
      }
      writeDrafts(stateDir, drafts);
      return;
    }
    if (sub === 'send') {
      const drafts = readDrafts(stateDir).filter((d) => d.status === 'approved');
      if (!live) {
        console.log(JSON.stringify({ dryRun: true, count: drafts.length }));
        return;
      }
      const actions = await connectActionsLive();
      for (const d of drafts) {
        const result = await dispatchOne(
          store,
          { conversationUrn: d.conversationUrn, text: d.text, inboundFp: d.inboundFp },
          { sendEnabled: true, maxSendsPerDay: 10, minGapSec: 60, maxGapSec: 120, dryRun: false },
          {},
          (urn, text, isLive) => actions.sendMessage(urn, text, { live: isLive }),
        );
        console.log(JSON.stringify({ id: d.id, ...result }));
      }
      return;
    }
    throw new Error('messaging: ingest | list | approve | reject | edit | send [--live]');
  }

  if (domain === 'capture-query-ids') {
    if (!cdpUrl) throw new Error('--cdp-url required');
    const actions = await connectActionsLive();
    try {
      const cdp = actions.linkedInSession.session;
      if (!cdp) throw new Error('CDP session missing');
      const out = await captureGraphqlQueryIds(cdp);
      console.log(JSON.stringify(out, null, 2));
    } finally {
      await actions.linkedInSession.close();
    }
    return;
  }

  if (domain === 'connections') {
    if (!cdpUrl) throw new Error('--cdp-url required');
    const actions = await connectActionsLive();
    try {
      console.log(JSON.stringify(await scrapeConnections({ live }), null, 2));
    } finally {
      await actions.linkedInSession.close();
    }
    return;
  }

  if (!cdpUrl) throw new Error('--cdp-url required');
  const actions = await connectActionsLive();
  const cmd = domain;
  try {
    switch (cmd) {
      case 'profile': {
        const slug = argv[1];
        console.log(JSON.stringify(await actions.fetchProfile(slug!, { posts: argv.includes('--posts') }), null, 2));
        break;
      }
      case 'inbox':
        console.log(JSON.stringify(await actions.listConversations({ days: Number(flag('--days') ?? '14') }), null, 2));
        break;
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  } finally {
    await actions.linkedInSession.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});