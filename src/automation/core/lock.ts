import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync, closeSync, constants, mkdirSync } from 'node:fs';

export type RunLockOptions = {
  staleMs?: number;
  pid?: number;
};

export function tryAcquireRunLock(lockPath: string, opts: RunLockOptions = {}): boolean {
  const staleMs = opts.staleMs ?? 4 * 60 * 60 * 1000;
  const pid = opts.pid ?? process.pid;
  mkdirSync(lockPath.replace(/\/[^/]+$/, ''), { recursive: true });

  if (existsSync(lockPath)) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; at?: string };
      const at = existing.at ? Date.parse(existing.at) : 0;
      const alive = existing.pid ? isPidAlive(existing.pid) : false;
      if (alive && Date.now() - at < staleMs) return false;
      unlinkSync(lockPath);
    } catch {
      try {
        unlinkSync(lockPath);
      } catch {
        return false;
      }
    }
  }

  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeFileSync(fd, JSON.stringify({ pid, at: new Date().toISOString() }), 'utf8');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function releaseRunLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}