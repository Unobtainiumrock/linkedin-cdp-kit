import { randomUUID } from 'node:crypto';
import type { RunReport } from './types.js';

export function beginRunReport(module: string, dryRun: boolean): { report: RunReport; finish: (patch?: Partial<RunReport>) => RunReport } {
  const startedAt = new Date().toISOString();
  const report: RunReport = {
    runId: randomUUID(),
    startedAt,
    finishedAt: startedAt,
    dryRun,
    module,
    actions: [],
    gateBlocks: [],
    held: false,
  };
  return {
    report,
    finish(patch = {}) {
      const finished: RunReport = {
        ...report,
        ...patch,
        finishedAt: new Date().toISOString(),
        actions: patch.actions ?? report.actions,
        gateBlocks: patch.gateBlocks ?? report.gateBlocks,
      };
      return finished;
    },
  };
}