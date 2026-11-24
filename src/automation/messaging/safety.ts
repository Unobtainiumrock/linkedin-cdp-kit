export const INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all )?(?:previous|prior|above) (?:instructions?|prompts?|rules?)/i,
  /forget (?:everything|all|your) (?:instructions?|rules?|prompts?)/i,
  /you are now\b/i,
  /new (?:instructions?|role|persona|identity)\s*:/i,
  /system\s*(?:prompt|message)\s*:/i,
  /override\s+(?:your|the)\s+(?:instructions?|rules?)/i,
  /pretend (?:you are|to be)\b/i,
  /disregard\b.*\b(?:instructions?|rules?|guidelines?)\b/i,
  /reveal\b.*\b(?:system|prompt|instructions?)\b/i,
];

export function sanitizeInbound(message: string): { sanitized: string; violations: string[] } {
  let sanitized = message || '';
  const violations: string[] = [];
  for (const p of INJECTION_PATTERNS) {
    const m = sanitized.match(p);
    if (m) {
      violations.push(`injection:${m[0]}`);
      sanitized = sanitized.replace(p, '[REDACTED]');
    }
  }
  return { sanitized, violations };
}

export function validateOutbound(text: string, minLen = 15): { ok: boolean; violations: string[] } {
  const violations: string[] = [];
  if ((text || '').trim().length < minLen) violations.push('too_short');
  return { ok: violations.length === 0, violations };
}