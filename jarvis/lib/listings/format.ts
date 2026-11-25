const eur = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

export function formatEUR(amount: number) {
  return eur.format(amount);
}

/** Parse a YYYY-MM-DD date at noon UTC so it never shifts a day across time zones. */
function parseDay(isoDate: string) {
  return new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
}

const dayMonth = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const dayMonthYear = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "1 Feb", or "1 Feb 2028" when it's not this year or next. */
export function formatDay(isoDate: string, now: string) {
  const d = parseDay(isoDate);
  const yearGap = d.getUTCFullYear() - parseDay(now).getUTCFullYear();
  return yearGap === 0 || yearGap === 1 ? dayMonth.format(d) : dayMonthYear.format(d);
}

export function isOnOrBefore(isoA: string, isoB: string) {
  return parseDay(isoA).getTime() <= parseDay(isoB).getTime();
}

/** Available now (or in the past) relative to `now`. */
export function isAvailableNow(isoDate: string, now: string) {
  return isOnOrBefore(isoDate, now);
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "12 min ago", "3 hours ago", "yesterday", "4 days ago". Deterministic against `now`. */
export function formatRelative(isoDateTime: string, now: string) {
  const diffMs = new Date(isoDateTime).getTime() - new Date(now).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 14) return rtf.format(days, "day");
  return rtf.format(Math.round(days / 7), "week");
}

export function hoursBetween(isoA: string, isoB: string) {
  return (new Date(isoB).getTime() - new Date(isoA).getTime()) / 3_600_000;
}

export function formatMonths(months: number) {
  if (months % 12 === 0) {
    const years = months / 12;
    return `${years} ${years === 1 ? "year" : "years"}`;
  }
  return `${months} ${months === 1 ? "month" : "months"}`;
}
