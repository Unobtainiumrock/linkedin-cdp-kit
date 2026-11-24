import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkCaptivePortal, waitForNetwork } from '../src/browser/network.js';
import { launchChrome } from '../src/browser/launch.js';
import { launchIsolatedChrome } from '../src/browser/provider.js';

describe('browser network', () => {
  it('waitForNetwork uses injectable TCP connect', async () => {
    const r = await waitForNetwork({
      hosts: ['example.com'],
      connect: async () => {},
    });
    assert.deepEqual(r.hosts, ['example.com']);
  });

  it('checkCaptivePortal accepts 204 and does not follow redirects', async () => {
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const r = await checkCaptivePortal(async (url, init) => {
      calls.push({ url: String(url), redirect: init?.redirect });
      return { status: 204, headers: { get: () => null } } as Response;
    });
    assert.equal(r.status, 'ok');
    assert.equal(calls[0]?.redirect, 'manual');
    assert.match(calls[0]?.url ?? '', /generate_204/);
    assert.equal(calls[0]?.url.includes('linkedin.com'), false);
  });

  it('checkCaptivePortal rejects redirect', async () => {
    const r = await checkCaptivePortal(
      async () => ({ status: 302, headers: { get: () => 'http://login.example.invalid' } } as Response),
    );
    assert.equal(r.status, 'network_unavailable');
  });
});

describe('launchChrome', () => {
  it('refuses default profile path', () => {
    assert.throws(() =>
      launchChrome({ userDataDir: join(process.env['HOME'] ?? tmpdir(), '.config', 'google-chrome'), port: 9222 }),
    );
  });

  it('spawns fake executable and records stop pid only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lcdp-chrome-'));
    const fake = join(dir, 'fake-chrome.sh');
    writeFileSync(
      fake,
      `#!/bin/sh\nprintf '%s\\n' "$@"\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    const userDataDir = join(dir, 'profile');
    const calls: string[][] = [];
    const killed: string[] = [];
    const launched = launchChrome({
      userDataDir,
      port: 18765,
      executable: fake,
      spawnFn: ((exe, args) => {
        calls.push([exe, ...(args as string[])]);
        return {
          pid: 424242,
          kill: (signal?: NodeJS.Signals | number) => {
            killed.push(String(signal ?? ''));
            return true;
          },
          stdout: { on: () => {} },
          stderr: { on: () => {} },
        };
      }) as typeof import('node:child_process').spawn,
    });
    assert.equal(launched.port, 18765);
    assert.equal(launched.cdpUrl, 'http://127.0.0.1:18765');
    assert.ok(calls[0]?.some((a) => a.includes('--user-data-dir=')));
    assert.ok(calls[0]?.includes('--remote-debugging-address=127.0.0.1'));
    const originalKill = process.kill;
    let foreignSignals = 0;
    process.kill = (() => {
      foreignSignals += 1;
      return true;
    }) as typeof process.kill;
    try {
      launched.stop();
    } finally {
      process.kill = originalKill;
    }
    assert.deepEqual(killed, ['SIGTERM']);
    assert.equal(foreignSignals, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('launchIsolatedChrome', () => {
  it('runs waitForNetwork before acquire when configured', async () => {
    let net = 0;
    const provider = launchIsolatedChrome({
      userDataDir: mkdtempSync(join(tmpdir(), 'lcdp-prof-')),
      port: 18765,
      executable: '/bin/true',
      networkCheck: { connect: async () => { net++; } },
      spawnFn: (() => ({ pid: 4242, kill: () => true, stdout: { on: () => {} }, stderr: { on: () => {} } })) as typeof import('node:child_process').spawn,
    });
    await assert.rejects(() => provider.acquire(), /LinkedIn tab|ECONNREFUSED|fetch|chrome/);
    assert.ok(net >= 1);
  });
});