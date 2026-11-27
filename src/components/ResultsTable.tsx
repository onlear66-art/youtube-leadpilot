import React, { useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Search,
} from 'lucide-react';
import type { QualifiedLead } from '../types/leadpilot';

interface ResultsTableProps {
  leads: QualifiedLead[];
  isRunning: boolean;
  driveOutputEnabled: boolean;
  canSaveToDrive: boolean;
  isSavingSheet: boolean;
  onDownloadCsv: () => void;
  onRequestSaveSheet: () => void;
}

function formatSubscribers(count: number): string {
  return count.toLocaleString('en-US');
}

export const ResultsTable: React.FC<ResultsTableProps> = ({
  leads,
  isRunning,
  driveOutputEnabled,
  canSaveToDrive,
  isSavingSheet,
  onDownloadCsv,
  onRequestSaveSheet,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredLeads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return leads;
    return leads.filter(
      (lead) =>
        lead.channelName.toLowerCase().includes(q) ||
        lead.channelUrl.toLowerCase().includes(q) ||
        (lead.country && lead.country.toLowerCase().includes(q)) ||
        lead.matchedKeyword.toLowerCase().includes(q)
    );
  }, [leads, searchQuery]);

  const handleCopyUrl = async (channelId: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(channelId);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === channelId ? null : prev));
      }, 1400);
    } catch {
      // Clipboard write unavailable in restricted context
    }
  };

  return (
    <section
      id="qualified-leads"
      className="bg-white border border-slate-200 rounded-lg overflow-hidden"
    >
      {/* Table Header & Actions */}
      <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900 tracking-tight">
            Qualified Leads Preview
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            <span className="font-mono tabular-nums">{leads.length}</span> collected
            <span aria-hidden="true" className="mx-1.5">
              ·
            </span>
            Export columns: Column A Channel Name / Column B Channel URL (RAW plain text)
            {!driveOutputEnabled && (
              <>
                <span aria-hidden="true" className="mx-1.5">
                  ·
                </span>
                <span className="text-slate-600 font-medium">
                  Drive Output OFF (CSV export only)
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onRequestSaveSheet}
            disabled={
              leads.length === 0 ||
              isRunning ||
              isSavingSheet ||
              !driveOutputEnabled ||
              !canSaveToDrive
            }
            title={
              !driveOutputEnabled
                ? 'Google Drive Output is OFF — enable it in Run Configuration to save a Google Sheet.'
                : !canSaveToDrive
                  ? 'Sign in with Google and provide an Output Drive Folder URL to save a Google Sheet.'
                  : undefined
            }
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-slate-900 disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-slate-600" />
            <span>{isSavingSheet ? 'Saving Sheet...' : 'Save New Sheet'}</span>
          </button>

          <button
            type="button"
            onClick={onDownloadCsv}
            disabled={leads.length === 0}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download CSV</span>
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="px-6 py-3 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between gap-4">
        <div className="relative w-full max-w-sm">
          <Search
            className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by channel name, country, or keyword..."
            aria-label="Filter qualified leads"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-500 transition-colors"
          />
        </div>

        {searchQuery.trim().length > 0 && (
          <p className="text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap shrink-0">
            Showing {filteredLeads.length} of {leads.length}
          </p>
        )}
      </div>

      {/* Table Body */}
      <div className="overflow-x-auto">
        {leads.length === 0 && !isRunning ? (
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-slate-900">
              No qualified channels collected yet
            </p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-md mx-auto leading-relaxed">
              Configure your keywords and target lead count on the left, optionally enable Sheet deduplication or Drive export, then start a discovery run.
            </p>
          </div>
        ) : leads.length === 0 && isRunning ? (
          <div className="divide-y divide-slate-100">
            {[1, 2, 3, 4, 5].map((row) => (
              <div
                key={row}
                className="px-6 h-11 flex items-center gap-6 animate-pulse"
              >
                <div className="w-6 h-3 bg-slate-200 rounded" />
                <div className="w-44 h-3 bg-slate-200 rounded" />
                <div className="w-64 h-3 bg-slate-100 rounded flex-1 max-w-xs" />
                <div className="w-16 h-3 bg-slate-100 rounded ml-auto" />
                <div className="w-10 h-3 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/50 text-xs font-medium text-slate-500">
                <th className="py-2.5 pl-6 pr-3 w-12 font-mono tabular-nums">#</th>
                <th className="py-2.5 px-3">Channel Name</th>
                <th className="py-2.5 px-3">Channel URL</th>
                <th className="py-2.5 px-3 text-right whitespace-nowrap">Subscribers</th>
                <th className="py-2.5 px-3 whitespace-nowrap">Country</th>
                <th className="py-2.5 pl-3 pr-6 whitespace-nowrap">Keyword</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredLeads.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-10 text-center text-xs text-slate-500"
                  >
                    No collected channels match &ldquo;{searchQuery}&rdquo;.
                  </td>
                </tr>
              ) : (
                filteredLeads.map((lead, index) => (
                  <tr
                    key={lead.channelId}
                    className="h-10 hover:bg-slate-50/80 transition-colors"
                  >
                    <td className="py-2 pl-6 pr-3 text-xs text-slate-400 font-mono tabular-nums">
                      {index + 1}
                    </td>
                    <td className="py-2 px-3 font-medium text-slate-900 max-w-[240px] truncate" title={lead.channelName}>
                      {lead.channelName}
                    </td>
                    <td className="py-2 px-3 max-w-[300px]">
                      <div className="flex items-center gap-2 min-w-0">
                        <a
                          href={lead.channelUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs font-mono text-slate-700 hover:text-slate-950 hover:underline truncate"
                        >
                          {lead.channelUrl}
                        </a>
                        <a
                          href={lead.channelUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Open ${lead.channelName} on YouTube`}
                          className="text-slate-400 hover:text-slate-700 shrink-0"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => handleCopyUrl(lead.channelId, lead.channelUrl)}
                          aria-label={`Copy channel URL for ${lead.channelName}`}
                          className="text-slate-400 hover:text-slate-700 shrink-0 transition-colors"
                        >
                          {copiedId === lead.channelId ? (
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right text-xs font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {formatSubscribers(lead.subscriberCount)}
                    </td>
                    <td className="py-2 px-3 text-xs font-mono text-slate-600 whitespace-nowrap">
                      {lead.country || '—'}
                    </td>
                    <td className="py-2 pl-3 pr-6 text-xs text-slate-500 max-w-[160px] truncate" title={lead.matchedKeyword}>
                      {lead.matchedKeyword}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
};
