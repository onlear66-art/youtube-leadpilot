import type {
  CountryFilterMode,
  PipelineProgress,
  QualifiedLead,
  RunStopReason,
  RunStreamEvent,
  SavedSheetInfo,
  WorkspaceValidationResult,
} from '../src/types/leadpilot.ts';
import {
  createStandaloneLeadsSheet,
  validateAndLoadWorkspace,
  WorkspaceApiError,
} from './workspace.ts';
import { getYouTubeQuotaSnapshot, type QuotaBucket } from './quota.ts';
import {
  checkRecentLongFormActivity,
  decodeChannelName,
  fetchChannelsBatch,
  searchVideosPage,
  YouTubeQuotaExceededError,
} from './youtube.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES_PER_KEYWORD = 12; // Safety ceiling past YouTube's ~500-result (~10 page) search cap

export interface PipelineRunParams {
  runId: string;
  stopToken?: string;
  accessToken: string | null;
  youtubeApiKey: string;
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
  shouldStop: () => boolean;
  emit: (event: RunStreamEvent) => void;
}

export async function executeDiscoveryPipeline(params: PipelineRunParams): Promise<void> {
  const {
    runId,
    stopToken,
    accessToken,
    youtubeApiKey,
    keywords,
    targetCount,
    minSubscribers,
    maxSubscribers,
    recencyDays,
    countryFilterMode,
    countryCodes,
    includeMissingCountry,
    enableSheetsDedupe,
    enableDriveOutput,
    masterSheetInput,
    tabName,
    outputFolderInput,
    tzOffsetMinutes,
    shouldStop,
    emit,
  } = params;

  // Fail-fast pre-flight validation & optional single-request Database tab load (only when Sheets or Drive is ON)
  let validation: WorkspaceValidationResult | null = null;
  let databaseChannelNames = new Set<string>();

  if (enableSheetsDedupe || enableDriveOutput) {
    if (!accessToken) {
      throw new WorkspaceApiError(
        'Google Workspace sign-in is required when Google Sheets Deduplication or Google Drive Output is enabled.',
        401,
        'AUTH_EXPIRED'
      );
    }

    const loaded = await validateAndLoadWorkspace({
      accessToken,
      enableSheetsDedupe,
      enableDriveOutput,
      masterSheetInput,
      tabName,
      outputFolderInput,
      onStep: (message) => emit({ type: 'status', message }),
    });
    validation = loaded.validation;
    databaseChannelNames = loaded.databaseChannelNames;
  }

  let runSearchCalls = 0;
  let runReadUnits = 0;
  const trackYouTubeUsage = (bucket: QuotaBucket) => {
    if (bucket === 'search') {
      runSearchCalls += 1;
    } else {
      runReadUnits += 1;
    }
  };
  const snapshotQuota = () => getYouTubeQuotaSnapshot(runSearchCalls, runReadUnits);

  emit({
    type: 'init',
    runId,
    stopToken,
    workspace: validation,
    totalKeywords: keywords.length,
    targetCount,
    quota: snapshotQuota(),
  });

  const countryCodesSet = new Set(
    countryCodes
      .map((code) => code.trim().toUpperCase())
      .filter((code) => /^[A-Z]{2}$/.test(code))
  );

  // Deduplication sets
  const seenChannelIds = new Set<string>();
  const runChannelNames = new Set<string>();
  const qualifiedLeads: QualifiedLead[] = [];

  const progress: PipelineProgress = {
    activeKeyword: keywords[0] || '',
    activeKeywordIndex: 0,
    totalKeywords: keywords.length,
    currentPage: 0,
    channelsInspected: 0,
    duplicatesSkipped: 0,
    disqualifiedSkipped: 0,
    disqualifiedBreakdown: {
      subscribers: 0,
      country: 0,
      activity: 0,
    },
    qualifiedCount: 0,
    targetCount,
    existingDatabaseCount: databaseChannelNames.size,
  };

  const snapshotProgress = (): PipelineProgress => ({
    ...progress,
    disqualifiedBreakdown: { ...progress.disqualifiedBreakdown },
  });

  const recencyCutoffMs =
    recencyDays !== null ? Date.now() - recencyDays * DAY_MS : null;

  let stopReason: RunStopReason = 'keywords_exhausted';
  let statusMessage = '';
  let exactErrorMessage: string | null = null;

  try {
    keywordLoop: for (let kwIndex = 0; kwIndex < keywords.length; kwIndex++) {
      if (shouldStop()) {
        stopReason = 'user_stopped';
        break keywordLoop;
      }

      const keyword = keywords[kwIndex];
      progress.activeKeyword = keyword;
      progress.activeKeywordIndex = kwIndex + 1;
      progress.currentPage = 0;
      emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });

      let nextPageToken: string | undefined = undefined;
      let pageCount = 0;

      while (pageCount < MAX_PAGES_PER_KEYWORD) {
        if (shouldStop()) {
          stopReason = 'user_stopped';
          break keywordLoop;
        }
        if (qualifiedLeads.length >= targetCount) {
          stopReason = 'target_reached';
          break keywordLoop;
        }

        pageCount += 1;
        progress.currentPage = pageCount;
        emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });

        // Step A — Sequential Keyword Discovery (search.list)
        const searchPage = await searchVideosPage(
          youtubeApiKey,
          keyword,
          nextPageToken,
          trackYouTubeUsage
        );

        if (shouldStop()) {
          stopReason = 'user_stopped';
          break keywordLoop;
        }

        // Deduplicate channel IDs within the run & immediately check exact Channel Name duplicates (Zero extra quota)
        const candidateBatch: Array<{ channelId: string; searchTitle: string }> = [];

        for (const item of searchPage.candidates) {
          if (seenChannelIds.has(item.channelId)) {
            continue;
          }
          seenChannelIds.add(item.channelId);
          progress.channelsInspected += 1;

          // Step B — Immediate Exact Duplicate Check (only when Google Sheets Deduplication is ON)
          if (
            enableSheetsDedupe &&
            (databaseChannelNames.has(item.channelTitle) ||
              runChannelNames.has(item.channelTitle))
          ) {
            progress.duplicatesSkipped += 1;
            continue;
          }

          candidateBatch.push({
            channelId: item.channelId,
            searchTitle: item.channelTitle,
          });
        }

        emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });

        // Step C — Qualification Criteria (ordered from lowest to highest quota cost)
        if (candidateBatch.length > 0) {
          const batchIds = candidateBatch.map((c) => c.channelId);
          const channelDetailsMap = await fetchChannelsBatch(
            youtubeApiKey,
            batchIds,
            trackYouTubeUsage
          );

          if (shouldStop()) {
            stopReason = 'user_stopped';
            break keywordLoop;
          }

          for (const candidate of candidateBatch) {
            if (shouldStop()) {
              stopReason = 'user_stopped';
              break keywordLoop;
            }
            if (qualifiedLeads.length >= targetCount) {
              stopReason = 'target_reached';
              break keywordLoop;
            }

            const details = channelDetailsMap.get(candidate.channelId);
            if (!details) {
              progress.disqualifiedSkipped += 1;
              continue;
            }

            // Canonical decoded channel title (strict exact match without case/emoji normalization)
            const canonicalName = decodeChannelName(details.snippet?.title ?? candidate.searchTitle);

            if (!canonicalName.trim()) {
              progress.disqualifiedSkipped += 1;
              emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });
              continue;
            }

            // Re-verify exact duplicate check against Database & current-run sets (only when Sheets Deduplication is ON)
            if (
              enableSheetsDedupe &&
              (databaseChannelNames.has(canonicalName) ||
                runChannelNames.has(canonicalName))
            ) {
              progress.duplicatesSkipped += 1;
              emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });
              continue;
            }

            // Rule 1: Subscriber Count Rule (always skip hidden counts; apply optional Min / Max bounds)
            if (details.statistics?.hiddenSubscriberCount === true) {
              progress.disqualifiedSkipped += 1;
              progress.disqualifiedBreakdown.subscribers += 1;
              emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });
              continue;
            }

            const rawSubCount = details.statistics?.subscriberCount;
            const subCount = rawSubCount !== undefined ? Number(rawSubCount) : NaN;
            if (
              Number.isNaN(subCount) ||
              (minSubscribers !== null && subCount < minSubscribers) ||
              (maxSubscribers !== null && subCount > maxSubscribers)
            ) {
              progress.disqualifiedSkipped += 1;
              progress.disqualifiedBreakdown.subscribers += 1;
              emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });
              continue;
            }

            // Rule 2: Country Filter Rule (Exclude / Include Only + optional blank-country inclusion)
            const countryRaw = details.snippet?.country;
            const trimmedCountry = countryRaw ? String(countryRaw).trim().toUpperCase() : '';
            const countryCode = trimmedCountry.length > 0 ? trimmedCountry : null;

            let countryDisqualified = false;
            if (!countryCode) {
              if (!includeMissingCountry) {
                countryDisqualified = true;
              }
            } else if (countryCodesSet.size > 0) {
              if (countryFilterMode === 'exclude') {
                if (countryCodesSet.has(countryCode)) {
                  countryDisqualified = true;
                }
              } else if (!countryCodesSet.has(countryCode)) {
                countryDisqualified = true;
              }
            }

            if (countryDisqualified) {
              progress.disqualifiedSkipped += 1;
              progress.disqualifiedBreakdown.country += 1;
              emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });
              continue;
            }

            // Rule 3: Optional Last Long-Form Upload Recency Rule (Excluding Shorts)
            let latestVideoAt: string | null = null;
            if (recencyCutoffMs !== null) {
              const activity = await checkRecentLongFormActivity(
                youtubeApiKey,
                candidate.channelId,
                details.contentDetails?.relatedPlaylists?.uploads,
                recencyCutoffMs,
                trackYouTubeUsage
              );

              if (shouldStop()) {
                stopReason = 'user_stopped';
                break keywordLoop;
              }

              if (!activity.qualified) {
                progress.disqualifiedSkipped += 1;
                progress.disqualifiedBreakdown.activity += 1;
                emit({ type: 'progress', progress: snapshotProgress(), quota: snapshotQuota() });
                continue;
              }
              latestVideoAt = activity.latestVideoAt;
            }

            if (shouldStop()) {
              stopReason = 'user_stopped';
              break keywordLoop;
            }

            // Step D — Collect & Stop Condition
            if (enableSheetsDedupe) {
              runChannelNames.add(canonicalName);
            }
            const qualifiedLead: QualifiedLead = {
              channelName: canonicalName,
              channelUrl: `https://www.youtube.com/channel/${candidate.channelId}`,
              channelId: candidate.channelId,
              subscriberCount: subCount,
              country: countryCode,
              latestVideoAt,
              matchedKeyword: keyword,
            };

            qualifiedLeads.push(qualifiedLead);
            progress.qualifiedCount = qualifiedLeads.length;

            emit({
              type: 'lead',
              lead: qualifiedLead,
              progress: snapshotProgress(),
              quota: snapshotQuota(),
            });

            if (qualifiedLeads.length >= targetCount) {
              stopReason = 'target_reached';
              break keywordLoop;
            }
          }
        }

        if (shouldStop()) {
          stopReason = 'user_stopped';
          break keywordLoop;
        }

        if (!searchPage.nextPageToken || searchPage.candidates.length === 0) {
          break;
        }
        nextPageToken = searchPage.nextPageToken;
      }
    }

    if (stopReason === 'target_reached') {
      statusMessage = `Target reached: collected ${qualifiedLeads.length} of ${targetCount} qualified leads.`;
    } else if (stopReason === 'user_stopped') {
      statusMessage = `Run stopped early: collected ${qualifiedLeads.length} of ${targetCount} qualified leads.`;
    } else {
      stopReason = 'keywords_exhausted';
      statusMessage = `All keywords exhausted: found ${qualifiedLeads.length} of ${targetCount} qualified leads.`;
    }
  } catch (err: unknown) {
    if (err instanceof YouTubeQuotaExceededError) {
      stopReason = 'quota_exceeded';
      exactErrorMessage = err.message;
      statusMessage = `Daily YouTube Data API search quota was reached after collecting ${qualifiedLeads.length} of ${targetCount} qualified leads.`;
    } else {
      stopReason = 'network_error';
      const detail = err instanceof Error ? err.message : 'Unexpected interruption during discovery.';
      exactErrorMessage = detail;
      statusMessage = `Discovery interrupted: ${detail}`;
    }
  }

  // Storage & Output Rules: Create a brand-new standalone Google Sheet only when Google Drive Output is ON
  let savedSheet: SavedSheetInfo | null = null;
  let saveError: string | null = null;
  let saveErrorCode: string | null = null;

  if (enableDriveOutput && accessToken && validation?.folderId && qualifiedLeads.length > 0) {
    emit({
      type: 'saving',
      message: `Creating standalone Google Sheet in "${validation.folderName}" with ${qualifiedLeads.length} qualified lead${qualifiedLeads.length === 1 ? '' : 's'}...`,
      progress: snapshotProgress(),
    });

    try {
      savedSheet = await createStandaloneLeadsSheet({
        accessToken,
        targetFolderId: validation.folderId,
        leads: qualifiedLeads,
        tzOffsetMinutes,
        onStep: (message) =>
          emit({
            type: 'saving',
            message,
            progress: snapshotProgress(),
          }),
      });
    } catch (err: unknown) {
      if (err instanceof WorkspaceApiError) {
        saveErrorCode = err.code;
      }
      saveError =
        err instanceof Error
          ? err.message
          : 'Failed to create the output Google Sheet. You can still download the CSV backup or retry saving.';
    }
  }

  emit({
    type: 'complete',
    reason: stopReason,
    message: statusMessage,
    errorMessage: exactErrorMessage,
    progress: snapshotProgress(),
    savedSheet,
    saveError,
    saveErrorCode,
    quota: snapshotQuota(),
  });
}
