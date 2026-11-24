// US cash-equity session in America/New_York.
// Full closes and 1:00 p.m. early closes are the NYSE list for 2026–2028:
// https://www.nyse.com/markets/hours-calendars
// https://ir.theice.com/press/news-details/2025/NYSE-Group-Announces-2026-2027-and-2028-Holiday-and-Early-Closings-Calendar/default.aspx

export const NYSE_HOLIDAYS = {
  '2026-01-01': "New Year's Day",
  '2026-01-19': 'Martin Luther King Jr. Day',
  '2026-02-16': "Washington's Birthday",
  '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day',
  '2026-06-19': 'Juneteenth',
  '2026-07-03': 'Independence Day',
  '2026-09-07': 'Labor Day',
  '2026-11-26': 'Thanksgiving',
  '2026-12-25': 'Christmas',
  '2027-01-01': "New Year's Day",
  '2027-01-18': 'Martin Luther King Jr. Day',
  '2027-02-15': "Washington's Birthday",
  '2027-03-26': 'Good Friday',
  '2027-05-31': 'Memorial Day',
  '2027-06-18': 'Juneteenth',
  '2027-07-05': 'Independence Day',
  '2027-09-06': 'Labor Day',
  '2027-11-25': 'Thanksgiving',
  '2027-12-24': 'Christmas',
  '2028-01-17': 'Martin Luther King Jr. Day',
  '2028-02-21': "Washington's Birthday",
  '2028-04-14': 'Good Friday',
  '2028-05-29': 'Memorial Day',
  '2028-06-19': 'Juneteenth',
  '2028-07-04': 'Independence Day',
  '2028-09-04': 'Labor Day',
  '2028-11-23': 'Thanksgiving',
  '2028-12-25': 'Christmas'
};

export const NYSE_EARLY_CLOSES = {
  '2026-11-27': 'Day after Thanksgiving',
  '2026-12-24': 'Christmas Eve',
  '2027-11-26': 'Day after Thanksgiving',
  '2028-07-03': 'Day before Independence Day',
  '2028-11-24': 'Day after Thanksgiving'
};

const PRE_START = 4 * 60;
const OPEN_START = 9 * 60 + 30;
const OPEN_END = 16 * 60;
const POST_END = 20 * 60;
const EARLY_OPEN_END = 13 * 60;
const EARLY_POST_END = 17 * 60;

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  weekday: 'short'
});

export function zonedParts(now) {
  const bag = {};
  for (const part of nyFormat.formatToParts(now)) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    minutes: hour * 60 + Number(bag.minute),
    weekday: bag.weekday
  };
}

export function statusFromClock(now) {
  const ny = zonedParts(now);
  const holiday = NYSE_HOLIDAYS[ny.date] || '';
  if (holiday) {
    return { status: 'closed', reason: 'holiday', holiday, earlyClose: '', date: ny.date };
  }
  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') {
    return { status: 'closed', reason: 'weekend', holiday: '', earlyClose: '', date: ny.date };
  }
  const earlyClose = NYSE_EARLY_CLOSES[ny.date] || '';
  const openEnd = earlyClose ? EARLY_OPEN_END : OPEN_END;
  const postEnd = earlyClose ? EARLY_POST_END : POST_END;
  let status = 'closed';
  if (ny.minutes >= PRE_START && ny.minutes < OPEN_START) status = 'pre-market';
  else if (ny.minutes >= OPEN_START && ny.minutes < openEnd) status = 'open';
  else if (ny.minutes >= openEnd && ny.minutes < postEnd) status = 'after-hours';
  return { status, reason: 'hours', holiday: '', earlyClose, date: ny.date };
}

function windowContains(span, seconds) {
  return !!(span && Number.isFinite(span.start) && Number.isFinite(span.end) && seconds >= span.start && seconds < span.end);
}

// Source session windows (Yahoo currentTradingPeriod) know the live exchange day,
// including an early close, when the payload includes them.
export function statusFromPeriods(now, periods) {
  if (!periods || !periods.regular) return '';
  const seconds = Math.floor(now.getTime() / 1000);
  if (windowContains(periods.pre, seconds)) return 'pre-market';
  if (windowContains(periods.regular, seconds)) return 'open';
  if (windowContains(periods.post, seconds)) return 'after-hours';
  return 'closed';
}

export function resolveMarketStatus(now, periods) {
  const clock = statusFromClock(now);
  if (clock.reason === 'holiday' || clock.reason === 'weekend') return clock;
  const fromSource = statusFromPeriods(now, periods);
  if (!fromSource) return clock;
  if (fromSource === clock.status) return clock;
  return { ...clock, status: fromSource, reason: 'source' };
}

export function statusLabel(market) {
  const names = {
    'pre-market': 'Pre-market',
    open: 'Open',
    'after-hours': 'After-hours',
    closed: 'Closed'
  };
  const base = names[market && market.status] || 'Closed';
  if (market && market.holiday) return `${base} · ${market.holiday}`;
  if (market && market.earlyClose && market.status !== 'closed') return `${base} · ${market.earlyClose}`;
  return base;
}
