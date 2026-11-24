import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type PersonaTier = 'tier1' | 'tier2' | 'tier3';
export type ContactCategory = 'buyer' | 'champion' | 'connector' | 'other';

export type AudiencePersona = {
  id: string;
  title: string;
  tiers: PersonaTier[];
  categories: ContactCategory[];
  disqualifiers: string[];
  evidenceRules: string[];
};

export type AudienceProfile = {
  version: number;
  personas: AudiencePersona[];
  globalDisqualifiers: string[];
  notes?: string;
};

export function loadStrategyFromJson(path: string): AudienceProfile {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as AudienceProfile;
  if (!Array.isArray(raw.personas)) throw new Error('strategy: personas required');
  return { ...raw, version: raw.version ?? 1, globalDisqualifiers: raw.globalDisqualifiers ?? [] };
}

export function loadStrategyFromMarkdownDir(dir: string): AudienceProfile {
  if (!existsSync(dir)) return { version: 1, personas: [], globalDisqualifiers: [] };
  const personas: AudiencePersona[] = [];
  const globalDisqualifiers: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    const id = file.replace(/\.md$/i, '');
    const disqualifiers = [...text.matchAll(/^-\s*disqualify:\s*(.+)$/gim)].map((m) => m[1]!.trim());
    const evidenceRules = [...text.matchAll(/^-\s*evidence:\s*(.+)$/gim)].map((m) => m[1]!.trim());
    const categories = [...text.matchAll(/^category:\s*(\w+)/gim)].map(
      (m) => m[1]!.toLowerCase() as ContactCategory,
    );
    const tiers = [...text.matchAll(/^tier:\s*(tier[123])/gim)].map((m) => m[1] as PersonaTier);
    const titleMatch = text.match(/^#\s+(.+)/m);
    personas.push({
      id,
      title: titleMatch?.[1]?.trim() ?? id,
      tiers: tiers.length ? tiers : ['tier2'],
      categories: categories.length ? categories : ['other'],
      disqualifiers,
      evidenceRules,
    });
    globalDisqualifiers.push(...disqualifiers);
  }
  return { version: 1, personas, globalDisqualifiers: [...new Set(globalDisqualifiers)] };
}

export function strategyContext(profile: AudienceProfile): Record<string, unknown> {
  return {
    personas: profile.personas.map((p) => ({ id: p.id, title: p.title, categories: p.categories, tiers: p.tiers })),
    globalDisqualifiers: profile.globalDisqualifiers,
  };
}