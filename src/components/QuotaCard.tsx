import React, { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import type { YouTubeQuotaSnapshot } from '../types/leadpilot';

interface QuotaCardProps {
  quota: YouTubeQuotaSnapshot | null;
  onResetRollover?: () => void;
}

function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return '0m';
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatLocalResetTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '12:00 AM local';
  return `${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} local`;
}

export const QuotaCard: React.FC<QuotaCardProps> = ({ quota, onResetRollover }) => {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [lastRolledOverResetAt, setLastRolledOverResetAt] = useState<string | null>(null);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  const resetMs = quota ? Date.parse(quota.nextResetAt) : NaN;
  const remainingMs = Number.isNaN(resetMs) ? 0 : Math.max(0, resetMs - nowMs);

  // When Pacific midnight passes, trigger a single refresh from /api/config so counters reset to 0
  useEffect(() => {
    if (!quota || !onResetRollover) return;
    if (!Number.isNaN(resetMs) && nowMs >= resetMs && lastRolledOverResetAt !== quota.nextResetAt) {
      setLastRolledOverResetAt(quota.nextResetAt);
      onResetRollover();
    }
  }, [quota, resetMs, nowMs, lastRolledOverResetAt, onResetRollover]);

  const searchUsed = quota?.searchCallsUsed ?? 0;
  const searchLimit = quota?.searchCallsLimit ?? 100;
  const readUsed = quota?.readUnitsUsed ?? 0;
  const readLimit = quota?.readUnitsLimit ?? 10_000;
  const runSearch = quota?.runSearchCalls ?? 0;
  const runRead = quota?.runReadUnits ?? 0;

  const searchRatio = searchLimit > 0 ? Math.min(1, searchUsed / searchLimit) : 0;
  const searchPercent = Math.round(searchRatio * 100);
  const isSearchExhausted = Boolean(quota?.searchExhausted) || searchUsed >= searchLimit;
  const isSearchWarning = !isSearchExhausted && searchRatio >= 0.8;
  const isReadExhausted = Boolean(quota?.readExhausted) || readUsed >= readLimit;

  const resetLabel = quota
    ? `Resets in ${formatCountdown(remainingMs)} (${formatLocalResetTime(quota.nextResetAt)})`
    : 'Calculating next Pacific reset...';

  return (
    <section
      aria-label="YouTube API Quota Tracker"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      {/* Compact Header */}
      <div className="px-6 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-700 whitespace-nowrap">
            YouTube API Quota (Est.)
          </h2>
          {(isSearchExhausted || isReadExhausted) && (
            <span className="text-[11px] font-semibold text-red-700 whitespace-nowrap">
              · Daily Limit Reached
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-xs font-mono tabular-nums text-slate-600 whitespace-nowrap shrink-0">
          <Clock className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden="true" />
          <span>{resetLabel}</span>
        </div>
      </div>

      {/* 3-Column Compact Quota Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        {/* Search Calls Today + Progress Bar */}
        <div className="px-6 py-3.5 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-slate-500">Search Calls Today</span>
            <span
              className={`text-xs font-mono tabular-nums font-semibold ${
                isSearchExhausted
                  ? 'text-red-700'
                  : isSearchWarning
                    ? 'text-amber-700'
                    : 'text-slate-950'
              }`}
            >
              {searchUsed.toLocaleString()}
              <span className="font-normal text-slate-400"> / {searchLimit.toLocaleString()}</span>
            </span>
          </div>
          <div
            className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden"
            role="progressbar"
            aria-label="Daily YouTube search calls used"
            aria-valuenow={Math.min(searchUsed, searchLimit)}
            aria-valuemin={0}
            aria-valuemax={searchLimit}
          >
            <div
              className={`h-full transition-transform duration-200 ease-out origin-left ${
                isSearchExhausted
                  ? 'bg-red-600'
                  : isSearchWarning
                    ? 'bg-amber-600'
                    : 'bg-slate-900'
              }`}
              style={{
                transform: `scaleX(${searchPercent / 100})`,
              }}
            />
          </div>
        </div>

        {/* Read Units Today */}
        <div className="px-6 py-3.5 flex flex-col justify-center">
          <span className="text-xs text-slate-500">Read Units Today</span>
          <p
            className={`text-sm font-mono tabular-nums font-semibold mt-1 ${
              isReadExhausted ? 'text-red-700' : 'text-slate-950'
            }`}
          >
            {readUsed.toLocaleString()}
            <span className="text-xs font-normal text-slate-400">
              {' '}
              / {readLimit.toLocaleString()}
            </span>
          </p>
        </div>

        {/* This Run */}
        <div className="px-6 py-3.5 flex flex-col justify-center">
          <span className="text-xs text-slate-500">This Run</span>
          <p className="text-sm font-mono tabular-nums font-semibold text-slate-950 mt-1">
            {runSearch.toLocaleString()}{' '}
            <span className="text-xs font-normal text-slate-500">search</span>
            <span aria-hidden="true" className="mx-1.5 text-slate-300 font-normal">
              ·
            </span>
            {runRead.toLocaleString()}{' '}
            <span className="text-xs font-normal text-slate-500">read</span>
          </p>
        </div>
      </div>

      {/* Subtle Attribution Note */}
      <div className="px-6 py-2 bg-slate-50/70 border-t border-slate-100">
        <p className="text-[11px] text-slate-500">
          Counts reflect requests made through LeadPilot and reset automatically at midnight Pacific Time (America/Los_Angeles).
        </p>
      </div>
    </section>
  );
};
