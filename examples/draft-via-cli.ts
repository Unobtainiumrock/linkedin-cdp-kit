/**
 * Example draft adapter: shell out to any CLI command defined in config.
 * The command receives JSON on stdin and must print { "text": "..." } or { "skip": true, "reason": "..." }.
 */
import { spawnSync } from 'node:child_process';

export type CliDraftConfig = {
  command: string[];
  timeoutMs?: number;
};

export function draftViaCli(cfg: CliDraftConfig, input: unknown): { text: string } | { skip: true; reason: string } {
  const result = spawnSync(cfg.command[0]!, cfg.command.slice(1), {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: cfg.timeoutMs ?? 120_000,
  });
  if (result.status !== 0) return { skip: true, reason: result.stderr || 'cli_failed' };
  try {
    const parsed = JSON.parse(result.stdout) as { text?: string; skip?: boolean; reason?: string };
    if (parsed.skip) return { skip: true, reason: parsed.reason ?? 'skip' };
    if (parsed.text) return { text: parsed.text };
    return { skip: true, reason: 'invalid_cli_output' };
  } catch {
    return { skip: true, reason: 'invalid_json' };
  }
}