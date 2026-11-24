import { pathToFileURL } from 'node:url';

export type HooksModule = {
  qualify?: (candidate: { slug: string; name: string }) => { decision: 'qualify' | 'reject' | 'needs_research'; reason?: string };
  draft?: (post: { text: string; activityId?: string | null }, ctx: { slug: string }) =>
    | Promise<{ text: string } | { skip: true; reason: string }>
    | { text: string }
    | { skip: true; reason: string };
  classify?: (thread: Record<string, unknown>) => Promise<{ label: string } | { skip: true; reason: string }>;
};

export async function loadHooksModule(filePath: string): Promise<HooksModule> {
  const mod = (await import(pathToFileURL(filePath).href)) as { default?: HooksModule } & HooksModule;
  return mod.default ?? mod;
}