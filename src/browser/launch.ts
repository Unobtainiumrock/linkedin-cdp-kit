import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type LaunchChromeOptions = {
  userDataDir: string;
  port: number;
  executable?: string;
  args?: string[];
  spawnFn?: typeof spawn;
};

export type LaunchedChrome = {
  pid: number;
  port: number;
  cdpUrl: string;
  stop(): void;
};

const DEFAULT_PROFILE_MARKERS = [
  join(homedir(), '.config', 'google-chrome'),
  join(homedir(), '.config', 'chromium'),
  join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
];

function isDefaultChromeProfile(userDataDir: string): boolean {
  const norm = userDataDir.replace(/\/$/, '');
  return DEFAULT_PROFILE_MARKERS.some((m) => norm === m.replace(/\/$/, '') || norm.startsWith(`${m}/Default`));
}

export function launchChrome(opts: LaunchChromeOptions): LaunchedChrome {
  const userDataDir = opts.userDataDir.trim();
  if (!userDataDir) throw new Error('userDataDir is required');
  if (isDefaultChromeProfile(userDataDir)) {
    throw new Error('refuse_default_chrome_profile');
  }
  const port = opts.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_debug_port');
  const executable = opts.executable ?? 'google-chrome';
  const extra = opts.args ?? [];
  const spawnFn = opts.spawnFn ?? spawn;
  const argv = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    ...extra,
  ];
  let child: ChildProcess;
  try {
    child = spawnFn(executable, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`chrome_spawn_failed:${msg}`);
  }
  const pid = child.pid;
  if (!pid) throw new Error('chrome_spawn_no_pid');
  const cdpUrl = `http://127.0.0.1:${port}`;
  return {
    pid,
    port,
    cdpUrl,
    stop() {
      try {
        process.kill(pid);
      } catch {
        /* already exited */
      }
    },
  };
}