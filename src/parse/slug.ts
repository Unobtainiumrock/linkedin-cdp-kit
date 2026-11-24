export function toSlug(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(input);
  let slug = m ? m[1]! : input;
  slug = slug.replace(/^\/+|\/+$/g, '').trim();
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* leave as-is */
  }
  if (!slug || slug.includes('/') || /^https?:/i.test(slug)) return null;
  return slug;
}