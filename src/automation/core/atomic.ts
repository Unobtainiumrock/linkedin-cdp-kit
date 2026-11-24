import { mkdirSync, openSync, closeSync, fsyncSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'w');
  try {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(fd, body, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}