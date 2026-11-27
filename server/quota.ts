import type { YouTubeQuotaSnapshot } from '../src/types/leadpilot.ts';

export const PACIFIC_TIMEZONE = 'America/Los_Angeles';
export const DAILY_SEARCH_CALL_LIMIT = 100;
export const DAILY_READ_UNIT_LIMIT = 10_000;

export type QuotaBucket = 'search' | 'read';

interface PacificClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const pacificPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function getPacificParts(date: Date): PacificClockParts {
  const parts = pacificPartsFormatter.formatToParts(date);
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }

  return { year, month, day, hour, minute, second };
}

export function getPacificDateKey(now = new Date()): string {
  const { year, month, day } = getPacificParts(now);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Compute the exact UTC ISO timestamp for the next 00:00:00 in America/Los_Angeles,
 * accurately handling PST (UTC-8) and PDT (UTC-7) daylight saving transitions.
 */
export function getNextPacificMidnightIso(now = new Date()): string {
  const { year, month, day } = getPacificParts(now);
  // Target calendar date = tomorrow in Pacific Time
  const targetMidnightAsUtc = Date.UTC(year, month - 1, day + 1, 0, 0, 0);
  // Initial guess: 08:00 UTC (PST midnight)
  let candidateMs = targetMidnightAsUtc + 8 * 60 * 60 * 1000;

  for (let i = 0; i < 3; i++) {
    const actual = getPacificParts(new Date(candidateMs));
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const diffMs = actualAsUtc - targetMidnightAsUtc;
    if (diffMs === 0) break;
    candidateMs -= diffMs;
  }

  return new Date(candidateMs).toISOString();
}

interface DailyQuotaState {
  pacificDate: string;
  searchCallsUsed: number;
  readUnitsUsed: number;
  searchExhausted: boolean;
  readExhausted: boolean;
}

const dailyQuota: DailyQuotaState = {
  pacificDate: getPacificDateKey(),
  searchCallsUsed: 0,
  readUnitsUsed: 0,
  searchExhausted: false,
  readExhausted: false,
};

function ensureCurrentPacificDay(now = new Date()): void {
  const todayKey = getPacificDateKey(now);
  if (dailyQuota.pacificDate !== todayKey) {
    dailyQuota.pacificDate = todayKey;
    dailyQuota.searchCallsUsed = 0;
    dailyQuota.readUnitsUsed = 0;
    dailyQuota.searchExhausted = false;
    dailyQuota.readExhausted = false;
  }
}

export function recordYouTubeQuotaUsage(bucket: QuotaBucket, count = 1): void {
  ensureCurrentPacificDay();
  const increment = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1;
  if (bucket === 'search') {
    dailyQuota.searchCallsUsed += increment;
  } else {
    dailyQuota.readUnitsUsed += increment;
  }
}

export function markYouTubeQuotaExhausted(bucket: QuotaBucket): void {
  ensureCurrentPacificDay();
  if (bucket === 'search') {
    dailyQuota.searchCallsUsed = Math.max(dailyQuota.searchCallsUsed, DAILY_SEARCH_CALL_LIMIT);
    dailyQuota.searchExhausted = true;
  } else {
    dailyQuota.readUnitsUsed = Math.max(dailyQuota.readUnitsUsed, DAILY_READ_UNIT_LIMIT);
    dailyQuota.readExhausted = true;
  }
}

export function getYouTubeQuotaSnapshot(
  runSearchCalls = 0,
  runReadUnits = 0
): YouTubeQuotaSnapshot {
  const now = new Date();
  ensureCurrentPacificDay(now);

  return {
    pacificDate: dailyQuota.pacificDate,
    nextResetAt: getNextPacificMidnightIso(now),
    searchCallsUsed: dailyQuota.searchCallsUsed,
    searchCallsLimit: DAILY_SEARCH_CALL_LIMIT,
    readUnitsUsed: dailyQuota.readUnitsUsed,
    readUnitsLimit: DAILY_READ_UNIT_LIMIT,
    runSearchCalls,
    runReadUnits,
    searchExhausted:
      dailyQuota.searchExhausted || dailyQuota.searchCallsUsed >= DAILY_SEARCH_CALL_LIMIT,
    readExhausted:
      dailyQuota.readExhausted || dailyQuota.readUnitsUsed >= DAILY_READ_UNIT_LIMIT,
  };
}
