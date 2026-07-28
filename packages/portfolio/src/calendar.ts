import type { Market } from "@quantrade/core";
import nse from "./calendars/nse.json";
import us from "./calendars/us.json";

interface CalendarFile {
  market: string;
  reviewedThrough: string;
  holidays: string[];
}

const CALENDARS: Record<Market, CalendarFile> = { NSE: nse, US: us };
const HOLIDAYS: Record<Market, Set<string>> = {
  NSE: new Set(nse.holidays),
  US: new Set(us.holidays),
};

/** Parse YYYY-MM-DD as a UTC date. Using UTC throughout keeps the arithmetic
 *  free of DST discontinuities — these are calendar dates, not instants. */
function parse(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Expected a YYYY-MM-DD date, received "${date}"`);
  }
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date "${date}"`);
  return d;
}

function format(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function assertWithinHorizon(market: Market, date: string): void {
  const horizon = CALENDARS[market].reviewedThrough;
  if (date > horizon) {
    throw new Error(
      `${market} calendar is only reviewed through ${horizon}, but ${date} was requested. ` +
        `Update packages/portfolio/src/calendars/${market.toLowerCase()}.json before trading.`,
    );
  }
}

export function isSessionDay(market: Market, date: string): boolean {
  assertWithinHorizon(market, date);
  const day = parse(date).getUTCDay();
  if (day === 0 || day === 6) return false;
  return !HOLIDAYS[market].has(date);
}

export function nextSessionDay(market: Market, date: string): string {
  const cursor = parse(date);
  for (let i = 0; i < 30; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const candidate = format(cursor);
    if (isSessionDay(market, candidate)) return candidate;
  }
  throw new Error(`No ${market} session found within 30 days of ${date}`);
}

export function sessionsBetween(market: Market, from: string, to: string): string[] {
  const out: string[] = [];
  const cursor = parse(from);
  const end = parse(to);
  while (cursor.getTime() <= end.getTime()) {
    const candidate = format(cursor);
    if (isSessionDay(market, candidate)) out.push(candidate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export function addSessions(market: Market, date: string, n: number): string {
  if (n < 0) throw new Error("addSessions does not walk backwards");
  let cursor = date;
  for (let i = 0; i < n; i++) cursor = nextSessionDay(market, cursor);
  return cursor;
}
