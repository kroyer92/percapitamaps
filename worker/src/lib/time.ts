// Small timezone helpers (no extra dependencies).

function partsIn(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

// The UTC instant when the wall clock in `tz` shows the given local time.
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(new Date(guess), tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += Date.UTC(y, m - 1, d, h, min) - shown;
  }
  return new Date(guess);
}

export function localDate(date: Date, tz: string) {
  return partsIn(date, tz);
}

export function fmtIn(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

// Upcoming slot instants from now, `days` days ahead.
export function upcomingSlots(slots: string[], tz: string, from: Date, days = 14): Date[] {
  const out: Date[] = [];
  const start = partsIn(from, tz);
  for (let k = 0; k < days; k++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + k));
    for (const s of slots) {
      const [hh, mm] = s.split(':').map(Number);
      const at = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm || 0, tz);
      if (at > from) out.push(at);
    }
  }
  return out.sort((a, b) => +a - +b);
}
