export interface QualifiedLead {
  channelName: string;
  channelUrl: string;
  channelId: string;
  subscriberCount: number;
  country: string | null;
  latestVideoAt: string | null;
  matchedKeyword: string;
}

export interface WorkspaceValidationResult {
  sheetsEnabled: boolean;
  driveEnabled: boolean;
  spreadsheetId: string;
  spreadsheetTitle: string;
  tabName: string;
  channelNameColumn: string;
  existingChannelsCount: number;
  folderId: string;
  folderName: string;
}

export interface DisqualificationBreakdown {
  subscribers: number;
  country: number;
  activity: number;
}

export interface PipelineProgress {
  activeKeyword: string;
  activeKeywordIndex: number;
  totalKeywords: number;
  currentPage: number;
  channelsInspected: number;
  duplicatesSkipped: number;
  disqualifiedSkipped: number;
  disqualifiedBreakdown: DisqualificationBreakdown;
  qualifiedCount: number;
  targetCount: number;
  existingDatabaseCount: number;
}

export interface SavedSheetInfo {
  fileId: string;
  fileName: string;
  webViewLink: string;
  rowCount: number;
}

export type RunStopReason =
  | 'target_reached'
  | 'keywords_exhausted'
  | 'quota_exceeded'
  | 'user_stopped'
  | 'network_error';

export interface YouTubeQuotaSnapshot {
  pacificDate: string;
  nextResetAt: string;
  searchCallsUsed: number;
  searchCallsLimit: number;
  readUnitsUsed: number;
  readUnitsLimit: number;
  runSearchCalls: number;
  runReadUnits: number;
  searchExhausted: boolean;
  readExhausted: boolean;
}

export type RunStreamEvent =
  | {
      type: 'status';
      message: string;
    }
  | {
      type: 'init';
      runId: string;
      stopToken?: string;
      workspace: WorkspaceValidationResult | null;
      totalKeywords: number;
      targetCount: number;
      quota?: YouTubeQuotaSnapshot;
    }
  | {
      type: 'progress';
      progress: PipelineProgress;
      quota?: YouTubeQuotaSnapshot;
    }
  | {
      type: 'lead';
      lead: QualifiedLead;
      progress: PipelineProgress;
      quota?: YouTubeQuotaSnapshot;
    }
  | {
      type: 'saving';
      message: string;
      progress: PipelineProgress;
    }
  | {
      type: 'complete';
      reason: RunStopReason;
      message: string;
      errorMessage?: string | null;
      progress: PipelineProgress;
      savedSheet: SavedSheetInfo | null;
      saveError: string | null;
      saveErrorCode?: string | null;
      quota?: YouTubeQuotaSnapshot;
    }
  | {
      type: 'error';
      message: string;
      code?: string;
    };

export type CountryFilterMode = 'exclude' | 'include';

export interface StartRunPayload {
  keywords: string[];
  targetCount: number;
  minSubscribers: number | null;
  maxSubscribers: number | null;
  recencyDays: number | null;
  countryFilterMode: CountryFilterMode;
  countryCodes: string[];
  includeMissingCountry: boolean;
  enableSheetsDedupe: boolean;
  enableDriveOutput: boolean;
  masterSheetInput: string;
  tabName: string;
  outputFolderInput: string;
  tzOffsetMinutes: number;
}
