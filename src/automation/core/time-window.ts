export type AllowedHoursConfig = {
  timeZone: string;
  startHour: number;
  endHour: number;
};

export function localParts(date: Date, timeZone: string): { hour: number; minute: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    hour: get('hour') % 24,
    minute: get('minute'),
    ymd: `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`,
  };
}

export function isWithinAllowedHours(now: Date, cfg: AllowedHoursConfig): boolean {
  const { hour } = localParts(now, cfg.timeZone);
  if (cfg.startHour <= cfg.endHour) {
    return hour >= cfg.startHour && hour < cfg.endHour;
  }
  return hour >= cfg.startHour || hour < cfg.endHour;
}