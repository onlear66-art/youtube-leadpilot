import type { QualifiedLead, SavedSheetInfo, WorkspaceValidationResult } from '../src/types/leadpilot.ts';

const GOOGLE_ID_PATTERN = /^[a-zA-Z0-9_-]{10,128}$/;

export class WorkspaceApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = 'WORKSPACE_ERROR') {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
    this.code = code;
  }
}

export function extractSpreadsheetId(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch && GOOGLE_ID_PATTERN.test(urlMatch[1])) {
    return urlMatch[1];
  }

  if (GOOGLE_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function extractDriveFolderId(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch && GOOGLE_ID_PATTERN.test(folderMatch[1])) {
    return folderMatch[1];
  }

  const queryMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch && GOOGLE_ID_PATTERN.test(queryMatch[1])) {
    return queryMatch[1];
  }

  if (GOOGLE_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function columnIndexToLetter(index: number): string {
  let n = index + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result || 'A';
}

function escapeSheetTabName(tabName: string): string {
  return `'${tabName.replace(/'/g, "''")}'`;
}

export function formatOutputSheetName(tzOffsetMinutes = 0, now = new Date()): string {
  // tzOffsetMinutes follows Date.prototype.getTimezoneOffset() (UTC - local, in minutes)
  const safeOffset = Number.isFinite(tzOffsetMinutes)
    ? Math.max(-840, Math.min(840, Math.trunc(tzOffsetMinutes)))
    : 0;
  const localMs = now.getTime() - safeOffset * 60 * 1000;
  const localDate = new Date(localMs);

  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');
  const hours = String(localDate.getUTCHours()).padStart(2, '0');
  const minutes = String(localDate.getUTCMinutes()).padStart(2, '0');

  return `YouTube Leads - ${year}-${month}-${day} ${hours}-${minutes}`;
}

async function parseGoogleErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } };
    if (body?.error?.message) {
      return body.error.message;
    }
  } catch {
    // Ignore JSON parse errors
  }
  return fallback;
}

const WORKSPACE_TIMEOUT_MS = 15_000;

async function fetchWorkspaceWithTimeout(
  url: string,
  init: RequestInit,
  label: string
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(WORKSPACE_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const errName = (err as { name?: string })?.name;
    if (errName === 'TimeoutError' || errName === 'AbortError') {
      throw new WorkspaceApiError(
        `${label} timed out after 15 seconds.`,
        504,
        'WORKSPACE_TIMEOUT'
      );
    }
    const detail = err instanceof Error ? err.message : 'Network error';
    throw new WorkspaceApiError(
      `${label} request failed: ${detail}`,
      502,
      'WORKSPACE_NETWORK_ERROR'
    );
  }
}

export interface ValidatedWorkspaceBundle {
  validation: WorkspaceValidationResult;
  databaseChannelNames: Set<string>;
}

export async function validateAndLoadWorkspace(params: {
  accessToken: string;
  enableSheetsDedupe?: boolean;
  enableDriveOutput?: boolean;
  masterSheetInput: string;
  tabName: string;
  outputFolderInput: string;
  onStep?: (message: string) => void;
}): Promise<ValidatedWorkspaceBundle> {
  const {
    accessToken,
    enableSheetsDedupe = true,
    enableDriveOutput = true,
    masterSheetInput,
    outputFolderInput,
    onStep,
  } = params;
  const tabName = (params.tabName || '').trim();

  let spreadsheetId = '';
  let spreadsheetTitle = '';
  let channelNameColumnHeader = '';
  const databaseChannelNames = new Set<string>();

  let folderId = '';
  let folderName = '';

  if (enableSheetsDedupe) {
    if (!tabName || tabName.length > 100) {
      throw new WorkspaceApiError(
        'Deduplication Tab Name is required when Google Sheets Deduplication is ON (e.g. Database).',
        400,
        'INVALID_TAB_NAME'
      );
    }

    const parsedSheetId = extractSpreadsheetId(masterSheetInput);
    if (!parsedSheetId) {
      throw new WorkspaceApiError(
        'Invalid Master Database Google Sheet URL or ID. Paste the full Google Sheets URL or the spreadsheet ID.',
        400,
        'INVALID_SHEET_ID'
      );
    }
    spreadsheetId = parsedSheetId;
  }

  if (enableDriveOutput) {
    const parsedFolderId = extractDriveFolderId(outputFolderInput);
    if (!parsedFolderId) {
      throw new WorkspaceApiError(
        'Invalid Output Google Drive Folder URL or ID. Paste the full Google Drive folder link or folder ID.',
        400,
        'INVALID_FOLDER_ID'
      );
    }
    folderId = parsedFolderId;
  }

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
  };

  // 1. Validate Master Spreadsheet metadata and target tab existence (only when Sheets Deduplication is ON)
  if (enableSheetsDedupe) {
    onStep?.('Verifying Master Database Google Sheet...');
    const sheetMetaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=properties.title,sheets.properties.title`;

    const metaRes = await fetchWorkspaceWithTimeout(
      sheetMetaUrl,
      { headers: authHeaders },
      'Google Sheets API (metadata check)'
    );

    if (metaRes.status === 401) {
      throw new WorkspaceApiError(
        'Your Google Workspace session has expired. Please sign in with Google again.',
        401,
        'AUTH_EXPIRED'
      );
    }
    if (metaRes.status === 403 || metaRes.status === 404) {
      const apiMsg = await parseGoogleErrorMessage(
        metaRes,
        'Master Database Google Sheet could not be accessed.'
      );
      throw new WorkspaceApiError(
        `Cannot access Master Database Google Sheet (${spreadsheetId}): ${apiMsg}`,
        metaRes.status,
        'SHEET_ACCESS_ERROR'
      );
    }
    if (!metaRes.ok) {
      const apiMsg = await parseGoogleErrorMessage(metaRes, 'Failed to read Master Spreadsheet metadata.');
      throw new WorkspaceApiError(apiMsg, metaRes.status, 'SHEET_META_ERROR');
    }

    const metaJson = (await metaRes.json()) as {
      properties?: { title?: string };
      sheets?: Array<{ properties?: { title?: string } }>;
    };

    spreadsheetTitle = metaJson.properties?.title || 'Untitled Spreadsheet';
    const availableTabs = (metaJson.sheets || [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => Boolean(t));

    if (!availableTabs.includes(tabName)) {
      const tabList = availableTabs.length > 0 ? availableTabs.join(', ') : 'none found';
      throw new WorkspaceApiError(
        `Tab "${tabName}" was not found in "${spreadsheetTitle}". Available tabs: ${tabList}.`,
        400,
        'TAB_NOT_FOUND'
      );
    }
  }

  // 2. Validate Output Google Drive Folder existence, type, and write permission (only when Drive Output is ON)
  if (enableDriveOutput) {
    onStep?.('Verifying Output Google Drive Folder...');
    const folderUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      folderId
    )}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`;

    const folderRes = await fetchWorkspaceWithTimeout(
      folderUrl,
      { headers: authHeaders },
      'Google Drive API (folder check)'
    );

    if (folderRes.status === 401) {
      throw new WorkspaceApiError(
        'Your Google Workspace session has expired. Please sign in with Google again.',
        401,
        'AUTH_EXPIRED'
      );
    }
    if (folderRes.status === 403 || folderRes.status === 404) {
      const apiMsg = await parseGoogleErrorMessage(
        folderRes,
        'Target Google Drive folder could not be found or accessed.'
      );
      throw new WorkspaceApiError(
        `Cannot access Output Google Drive Folder (${folderId}): ${apiMsg}`,
        folderRes.status,
        'FOLDER_ACCESS_ERROR'
      );
    }
    if (!folderRes.ok) {
      const apiMsg = await parseGoogleErrorMessage(folderRes, 'Failed to verify target Google Drive folder.');
      throw new WorkspaceApiError(apiMsg, folderRes.status, 'FOLDER_VERIFY_ERROR');
    }

    const folderJson = (await folderRes.json()) as {
      id?: string;
      name?: string;
      mimeType?: string;
      trashed?: boolean;
      capabilities?: { canAddChildren?: boolean };
    };

    if (folderJson.trashed) {
      throw new WorkspaceApiError(
        `The target Google Drive folder "${folderJson.name || folderId}" is in the Trash. Please choose an active folder.`,
        400,
        'FOLDER_TRASHED'
      );
    }
    if (folderJson.mimeType !== 'application/vnd.google-apps.folder') {
      throw new WorkspaceApiError(
        `The Output Drive link points to "${folderJson.name || folderId}", which is not a Google Drive folder.`,
        400,
        'NOT_A_FOLDER'
      );
    }
    if (folderJson.capabilities && folderJson.capabilities.canAddChildren === false) {
      throw new WorkspaceApiError(
        `You do not have permission to create files inside the folder "${folderJson.name || folderId}".`,
        403,
        'FOLDER_READONLY'
      );
    }

    folderName = folderJson.name || 'Target Folder';
  }

  // 3. Read the entire Database tab in a SINGLE Sheets API request (only when Sheets Deduplication is ON)
  if (enableSheetsDedupe) {
    onStep?.(`Loading existing channels from "${tabName}" tab...`);
    const range = escapeSheetTabName(tabName);
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`;

    const valuesRes = await fetchWorkspaceWithTimeout(
      valuesUrl,
      { headers: authHeaders },
      `Google Sheets API (reading "${tabName}" tab)`
    );

    if (valuesRes.status === 401) {
      throw new WorkspaceApiError(
        'Your Google Workspace session has expired. Please sign in with Google again.',
        401,
        'AUTH_EXPIRED'
      );
    }
    if (!valuesRes.ok) {
      const apiMsg = await parseGoogleErrorMessage(valuesRes, `Failed to read rows from tab "${tabName}".`);
      throw new WorkspaceApiError(apiMsg, valuesRes.status, 'SHEET_READ_ERROR');
    }

    const valuesJson = (await valuesRes.json()) as { values?: string[][] };
    const rows = valuesJson.values || [];

    let channelNameColIndex = 0; // Default to Column A
    channelNameColumnHeader = 'Column A';

    if (rows.length > 0 && Array.isArray(rows[0])) {
      const headerRow = rows[0];
      const exactHeaderIndex = headerRow.findIndex((cell) => String(cell ?? '').trim() === 'Channel Name');
      const caseInsensitiveHeaderIndex =
        exactHeaderIndex >= 0
          ? exactHeaderIndex
          : headerRow.findIndex((cell) => String(cell ?? '').trim().toLowerCase() === 'channel name');

      if (caseInsensitiveHeaderIndex >= 0) {
        channelNameColIndex = caseInsensitiveHeaderIndex;
        channelNameColumnHeader = `Column ${columnIndexToLetter(channelNameColIndex)} ("${String(
          headerRow[channelNameColIndex]
        ).trim()}")`;
      } else {
        const colAHeader = String(headerRow[0] ?? '').trim();
        channelNameColumnHeader = colAHeader ? `Column A ("${colAHeader}")` : 'Column A (default)';
      }
    }

    // Load every non-empty cell value (excluding Row 1 header) verbatim into Set
    // Strict exact matching: preserve exact case, Unicode emojis, punctuation, and characters
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || row.length <= channelNameColIndex) continue;
      const rawValue = row[channelNameColIndex];
      if (rawValue === undefined || rawValue === null) continue;
      const strValue = String(rawValue);
      if (strValue.trim().length === 0) continue;
      databaseChannelNames.add(strValue);
    }
  }

  return {
    validation: {
      sheetsEnabled: enableSheetsDedupe,
      driveEnabled: enableDriveOutput,
      spreadsheetId,
      spreadsheetTitle,
      tabName: enableSheetsDedupe ? tabName : '',
      channelNameColumn: channelNameColumnHeader,
      existingChannelsCount: databaseChannelNames.size,
      folderId,
      folderName,
    },
    databaseChannelNames,
  };
}

export async function createStandaloneLeadsSheet(params: {
  accessToken: string;
  targetFolderId: string;
  leads: Array<Pick<QualifiedLead, 'channelName' | 'channelUrl'>>;
  tzOffsetMinutes?: number;
  onStep?: (message: string) => void;
}): Promise<SavedSheetInfo> {
  const { accessToken, targetFolderId, leads, tzOffsetMinutes = 0, onStep } = params;

  if (!GOOGLE_ID_PATTERN.test(targetFolderId)) {
    throw new WorkspaceApiError('Invalid target Google Drive folder ID.', 400, 'INVALID_FOLDER_ID');
  }

  const fileName = formatOutputSheetName(tzOffsetMinutes);

  // 1. Always create a brand-new standalone Google Sheet directly inside the target Drive folder
  onStep?.(`Creating Google Sheet "${fileName}" in Google Drive...`);
  const createRes = await fetchWorkspaceWithTimeout(
    'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: fileName,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: [targetFolderId],
      }),
    },
    'Google Drive API (creating output spreadsheet)'
  );

  if (createRes.status === 401) {
    throw new WorkspaceApiError(
      'Google Workspace access token expired before saving. Sign in again and click "Save New Sheet" or download the CSV backup.',
      401,
      'AUTH_EXPIRED'
    );
  }
  if (!createRes.ok) {
    const apiMsg = await parseGoogleErrorMessage(createRes, 'Failed to create new Google Sheet in target folder.');
    throw new WorkspaceApiError(apiMsg, createRes.status, 'CREATE_SHEET_ERROR');
  }

  const createdFile = (await createRes.json()) as {
    id: string;
    name?: string;
    webViewLink?: string;
  };

  const newSpreadsheetId = createdFile.id;
  const rows: string[][] = [
    ['Channel Name', 'Channel URL'],
    ...leads.map((lead) => [lead.channelName, lead.channelUrl]),
  ];

  // 2. Populate ONLY columns A & B with valueInputOption=RAW so exact capitalization, emojis, and plain text are preserved
  onStep?.(
    `Writing ${leads.length.toLocaleString()} qualified lead${leads.length === 1 ? '' : 's'} to "${createdFile.name || fileName}"...`
  );
  const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    newSpreadsheetId
  )}/values/A1:B1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const writeRes = await fetchWorkspaceWithTimeout(
    writeUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: rows,
      }),
    },
    'Google Sheets API (writing qualified leads)'
  );

  if (writeRes.status === 401) {
    throw new WorkspaceApiError(
      'Google Workspace access token expired while writing lead rows. Sign in again and click "Save New Sheet" or download the CSV backup.',
      401,
      'AUTH_EXPIRED'
    );
  }
  if (!writeRes.ok) {
    const apiMsg = await parseGoogleErrorMessage(writeRes, 'Created sheet, but failed to write lead rows.');
    throw new WorkspaceApiError(apiMsg, writeRes.status, 'WRITE_SHEET_ERROR');
  }

  const safeWebViewLink =
    createdFile.webViewLink &&
    (createdFile.webViewLink.startsWith('https://docs.google.com/') ||
      createdFile.webViewLink.startsWith('https://drive.google.com/'))
      ? createdFile.webViewLink
      : `https://docs.google.com/spreadsheets/d/${encodeURIComponent(newSpreadsheetId)}/edit`;

  return {
    fileId: newSpreadsheetId,
    fileName: createdFile.name || fileName,
    webViewLink: safeWebViewLink,
    rowCount: leads.length,
  };
}
