const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type DateRangeFormatted = {
  start: string | null;
  end: string | null;
  current: boolean;
  label: string;
} | null;

export type ParsedPosition = {
  title: string | null;
  company: string | null;
  location: string | null;
  dateRange: DateRangeFormatted;
  description: string | null;
};

export type ParsedProfile = {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  headline: string | null;
  summary: string | null;
  publicIdentifier: string | null;
  profileUrn: string | null;
  location: string | null;
  positions: ParsedPosition[];
  education: Array<{
    school: string | null;
    degree: string | null;
    field: string | null;
    dateRange: DateRangeFormatted;
  }>;
  skills: string[];
  certifications: Array<{ name: string | null; authority: string | null }>;
  featured: Array<{ title: string | null; description: string | null }>;
};

export type ParsedPost = {
  text: string;
  author: string | null;
  age: string | null;
  urn: string | null;
  activityId: string | null;
};

export type ProfilePostsMeta = {
  complete: boolean;
  truncated: boolean;
  error: string | null;
  pagesFetched: number;
};

type IncludedObject = Record<string, unknown>;

function ofType(included: IncludedObject[], suffix: string): IncludedObject[] {
  const dotted = `.${suffix}`;
  return included.filter((o) => typeof o['$type'] === 'string' && (o['$type'] as string).endsWith(dotted));
}

function formatDate(d: { year?: number; month?: number } | null | undefined): string | null {
  if (!d || !d.year) return null;
  const month = Number.isInteger(d.month) && (d.month as number) >= 1 && (d.month as number) <= 12 ? d.month : null;
  return month ? `${MONTHS[month as number]} ${d.year}` : String(d.year);
}

function formatRange(dateRange: { start?: unknown; end?: unknown } | null | undefined): DateRangeFormatted {
  if (!dateRange) return null;
  const start = formatDate(dateRange.start as { year?: number; month?: number });
  const end = formatDate(dateRange.end as { year?: number; month?: number });
  const hasEnd = dateRange.end !== null && dateRange.end !== undefined;
  if (!start && !hasEnd) return null;
  return {
    start,
    end,
    current: !hasEnd,
    label: `${start || '?'} – ${hasEnd ? end || '?' : 'Present'}`,
  };
}

function sortKey(entry: { dateRange?: { start?: { year?: number; month?: number } } | null }): number {
  const s = entry?.dateRange?.start;
  return ((s?.year || 0) as number) * 100 + ((s?.month || 0) as number);
}

function byDateDesc(
  a: { _sort: number; _label: string },
  b: { _sort: number; _label: string },
): number {
  if (b._sort !== a._sort) return b._sort - a._sort;
  return (a._label || '').localeCompare(b._label || '');
}

function parseJsonish(raw: unknown, what: string): unknown {
  if (raw === null || raw === undefined) throw new Error(`Empty ${what} response`);
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Unparseable ${what} response`);
  }
}

function activityIdFrom(entityUrn: string | null | undefined): string | null {
  const m = /urn:li:activity:(\d+)/.exec(entityUrn || '');
  return m?.[1] ?? null;
}

export function parseProfile(raw: unknown, opts: { expectPublicIdentifier?: string | null } = {}): ParsedProfile | null {
  const { expectPublicIdentifier = null } = opts;
  let data: { included?: IncludedObject[] };
  try {
    data = parseJsonish(raw, 'profile') as { included?: IncludedObject[] };
  } catch {
    return null;
  }
  const included = Array.isArray(data?.included) ? data.included : [];
  const candidates = ofType(included, 'identity.profile.Profile');
  if (candidates.length === 0) return null;

  let profile: IncludedObject;
  if (expectPublicIdentifier) {
    const want = String(expectPublicIdentifier).toLowerCase();
    const found = candidates.find((p) => String(p['publicIdentifier'] || '').toLowerCase() === want);
    if (!found) {
      const seen = candidates.map((p) => p['publicIdentifier'] || '?').join(', ');
      throw new Error(
        `Profile identity mismatch: asked for "${expectPublicIdentifier}" but the response contained [${seen}].`,
      );
    }
    profile = found;
  } else {
    profile = candidates[0]!;
  }

  const positions = ofType(included, 'Position')
    .map((p) => ({
      title: (p['title'] as string) || null,
      company: (p['companyName'] as string) || null,
      location: (p['locationName'] as string) || (p['geoLocationName'] as string) || null,
      dateRange: formatRange(p['dateRange'] as { start?: unknown; end?: unknown }),
      description: (p['description'] as string) || null,
      _sort: sortKey(p as { dateRange?: { start?: { year?: number; month?: number } } }),
      _label: `${p['companyName'] || ''}${p['title'] || ''}`,
    }))
    .sort(byDateDesc)
    .map(({ _sort, _label, ...rest }) => rest);

  const education = ofType(included, 'Education')
    .map((e) => ({
      school: (e['schoolName'] as string) || null,
      degree: (e['degreeName'] as string) || null,
      field: (e['fieldOfStudy'] as string) || null,
      dateRange: formatRange(e['dateRange'] as { start?: unknown; end?: unknown }),
      _sort: sortKey(e as { dateRange?: { start?: { year?: number; month?: number } } }),
      _label: (e['schoolName'] as string) || '',
    }))
    .sort(byDateDesc)
    .map(({ _sort, _label, ...rest }) => rest);

  return {
    firstName: (profile['firstName'] as string) || null,
    lastName: (profile['lastName'] as string) || null,
    name: [profile['firstName'], profile['lastName']].filter(Boolean).join(' ') || null,
    headline: (profile['headline'] as string) || null,
    summary: (profile['summary'] as string) || null,
    publicIdentifier: (profile['publicIdentifier'] as string) || null,
    profileUrn: (profile['entityUrn'] as string) || null,
    location: (profile['geoLocationName'] as string) || null,
    positions,
    education,
    skills: ofType(included, 'Skill')
      .map((s) => s['name'] as string)
      .filter(Boolean),
    certifications: ofType(included, 'Certification').map((c) => ({
      name: (c['name'] as string) || null,
      authority: (c['authority'] as string) || null,
    })),
    featured: ofType(included, 'TreasuryMedia').map((m) => ({
      title: (m['title'] as string) || null,
      description: (m['description'] as string) || null,
    })),
  };
}

export function parseProfileUpdates(raw: unknown): {
  posts: ParsedPost[];
  lastActivityId: bigint | null;
  apiError: unknown;
} {
  let data: { included?: IncludedObject[]; error?: unknown };
  try {
    data = parseJsonish(raw, 'updates') as { included?: IncludedObject[]; error?: unknown };
  } catch (err) {
    return { posts: [], lastActivityId: null, apiError: err instanceof Error ? err.message : String(err) };
  }

  if (data && data.error !== undefined && data.error !== null) {
    return { posts: [], lastActivityId: null, apiError: data.error };
  }

  const included = Array.isArray(data?.included) ? data.included : [];
  const posts: ParsedPost[] = [];
  let lastActivityId: bigint | null = null;

  for (const o of included) {
    const commentary = o['commentary'];
    if (!commentary || typeof commentary !== 'object') continue;
    const text = (commentary as { text?: { text?: string } }).text?.text;
    if (typeof text !== 'string') continue;

    const urn = (o['entityUrn'] as string) || null;
    const activityId = activityIdFrom(urn);
    posts.push({
      text,
      author: ((o['actor'] as { name?: { text?: string } })?.name?.text) || null,
      age: String(((o['actor'] as { subDescription?: { text?: string } })?.subDescription?.text) || '').trim() || null,
      urn,
      activityId,
    });

    if (activityId) {
      const id = BigInt(activityId);
      if (lastActivityId === null || id < lastActivityId) lastActivityId = id;
    }
  }

  return { posts, lastActivityId, apiError: null };
}