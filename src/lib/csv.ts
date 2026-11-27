import type { QualifiedLead } from '../types/leadpilot';

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

export function formatLocalTimestamp(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}-${minutes}`;
}

export function downloadLeadsCsv(leads: QualifiedLead[]): void {
  const header = `${escapeCsvCell('Channel Name')},${escapeCsvCell('Channel URL')}`;
  const lines = leads.map(
    (lead) => `${escapeCsvCell(lead.channelName)},${escapeCsvCell(lead.channelUrl)}`
  );
  // Prepend UTF-8 BOM so Excel and spreadsheet tools preserve exact Unicode emojis and characters
  const csvContent = `\uFEFF${[header, ...lines].join('\r\n')}`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `YouTube Leads - ${formatLocalTimestamp()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
