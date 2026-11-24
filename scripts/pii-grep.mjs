#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const patterns = [
  String.raw`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`,
  String.raw`\b\d{3}-\d{2}-\d{4}\b`,
  String.raw`\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]\d{4}\b`,
];

const dirs = ['src', 'bin', 'test', 'examples', 'scripts', 'README.md'];
let hits = 0;
for (const part of dirs) {
  const cmd = `rg -n --glob '!node_modules' --glob '!dist' --glob '!package-lock.json' -e '${patterns.join("' -e '")}' ${join(root, part)} 2>/dev/null || true`;
  const out = execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim();
  if (out) {
    hits += out.split('\n').filter(Boolean).length;
    console.log(out);
  }
}

if (hits > 0) {
  console.error(`PII grep: ${hits} hit(s)`);
  process.exit(1);
}
console.log('PII grep: 0 hits');
process.exit(0);