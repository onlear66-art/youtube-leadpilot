import { decode as decodeHtmlEntities } from 'he';
import {
  markYouTubeQuotaExhausted,
  recordYouTubeQuotaUsage,
  type QuotaBucket,
} from './quota.ts';

export type YouTubeUsageCallback = (bucket: QuotaBucket) => void;

export class YouTubeQuotaExceededError extends Error {
  constructor(message = 'YouTube Data API daily quota exceeded.') {
    super(message);
    this.name = 'YouTubeQuotaExceededError';
  }
}

export class YouTubeApiError extends Error {
  status: number;
  reason?: string;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = 'YouTubeApiError';
    this.status = status;
    this.reason = reason;
  }
}

export interface YouTubeSearchCandidate {
  channelId: string;
  channelTitle: string;
}

export interface YouTubeChannelDetails {
  id: string;
  snippet?: {
    title?: string;
    country?: string;
  };
  statistics?: {
    subscriberCount?: string;
    hiddenSubscriberCount?: boolean;
  };
  contentDetails?: {
    relatedPlaylists?: {
      uploads?: string;
    };
  };
}

interface YouTubeErrorResponse {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

/**
 * Decode HTML entities (e.g. &amp;, &#39;, &quot;) into clean plain text
 * while strictly preserving exact case, Unicode emojis, punctuation, and characters.
 */
export function decodeChannelName(raw: string): string {
  return decodeHtmlEntities(raw ?? '');
}

/**
 * Parse ISO 8601 duration (e.g. PT59S, PT1M2S, PT1H15M) into total seconds.
 */
export function parseIso8601DurationToSeconds(duration: string | undefined): number {
  if (!duration) return 0;
  const match = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return 0;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function hasShortsMarker(snippet?: { title?: string; description?: string; tags?: string[] }): boolean {
  if (!snippet) return false;
  const shortsRegex = /#shorts\b/i;
  if (snippet.title && shortsRegex.test(snippet.title)) return true;
  if (snippet.description && shortsRegex.test(snippet.description)) return true;
  if (Array.isArray(snippet.tags)) {
    for (const tag of snippet.tags) {
      const normalized = String(tag).trim().toLowerCase();
      if (normalized === 'shorts' || normalized === '#shorts' || shortsRegex.test(normalized)) {
        return true;
      }
    }
  }
  return false;
}

async function fetchYouTubeJson<T>(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
  options?: { allow404?: boolean; onUsage?: YouTubeUsageCallback }
): Promise<T | null> {
  const bucket: QuotaBucket = endpoint === 'search' ? 'search' : 'read';
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      url.searchParams.set(key, value);
    }
  }
  url.searchParams.set('key', apiKey);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: unknown) {
    const errName = (err as { name?: string })?.name;
    if (errName === 'TimeoutError' || errName === 'AbortError') {
      throw new YouTubeApiError(
        `YouTube Data API (${endpoint}) timed out after 15 seconds.`,
        504,
        'timeout'
      );
    }
    const detail = err instanceof Error ? err.message : 'Network error';
    throw new YouTubeApiError(
      `YouTube Data API (${endpoint}) request failed: ${detail}`,
      502,
      'networkError'
    );
  }

  if (options?.allow404 && res.status === 404) {
    recordYouTubeQuotaUsage(bucket, 1);
    options.onUsage?.(bucket);
    return null;
  }

  if (!res.ok) {
    let errorReason: string | undefined;
    let errorMessage = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as YouTubeErrorResponse;
      errorReason = body?.error?.errors?.[0]?.reason;
      if (body?.error?.message) {
        errorMessage = decodeHtmlEntities(body.error.message);
      }
    } catch {
      // Ignore parse failure
    }

    if (
      res.status === 403 &&
      (errorReason === 'quotaExceeded' ||
        errorReason === 'dailyLimitExceeded' ||
        errorReason === 'rateLimitExceeded' ||
        errorMessage.toLowerCase().includes('quota'))
    ) {
      markYouTubeQuotaExhausted(bucket);
      throw new YouTubeQuotaExceededError(
        `YouTube Data API (${endpoint}) HTTP 403 (${errorReason || 'quotaExceeded'}): ${errorMessage}`
      );
    }

    const reasonSuffix = errorReason ? ` [${errorReason}]` : '';
    throw new YouTubeApiError(
      `YouTube Data API (${endpoint}) failed with HTTP ${res.status}${reasonSuffix}: ${errorMessage}`,
      res.status,
      errorReason
    );
  }

  recordYouTubeQuotaUsage(bucket, 1);
  options?.onUsage?.(bucket);

  return (await res.json()) as T;
}

export async function searchVideosPage(
  apiKey: string,
  keyword: string,
  pageToken?: string,
  onUsage?: YouTubeUsageCallback
): Promise<{
  candidates: YouTubeSearchCandidate[];
  nextPageToken?: string;
}> {
  const params: Record<string, string> = {
    part: 'snippet',
    type: 'video',
    maxResults: '50',
    q: keyword,
  };
  if (pageToken) {
    params.pageToken = pageToken;
  }

  const data = await fetchYouTubeJson<{
    nextPageToken?: string;
    items?: Array<{
      snippet?: {
        channelId?: string;
        channelTitle?: string;
      };
    }>;
  }>('search', params, apiKey, { onUsage });

  const candidates: YouTubeSearchCandidate[] = [];
  for (const item of data?.items || []) {
    const channelId = item.snippet?.channelId;
    const channelTitle = item.snippet?.channelTitle;
    if (channelId && channelTitle) {
      candidates.push({
        channelId,
        channelTitle: decodeChannelName(channelTitle),
      });
    }
  }

  return {
    candidates,
    nextPageToken: data?.nextPageToken,
  };
}

export async function fetchChannelsBatch(
  apiKey: string,
  channelIds: string[],
  onUsage?: YouTubeUsageCallback
): Promise<Map<string, YouTubeChannelDetails>> {
  const result = new Map<string, YouTubeChannelDetails>();
  if (channelIds.length === 0) return result;

  // YouTube channels.list accepts up to 50 IDs per request
  for (let i = 0; i < channelIds.length; i += 50) {
    const chunk = channelIds.slice(i, i + 50);
    const data = await fetchYouTubeJson<{ items?: YouTubeChannelDetails[] }>(
      'channels',
      {
        part: 'snippet,statistics,contentDetails',
        id: chunk.join(','),
        maxResults: '50',
      },
      apiKey,
      { onUsage }
    );

    for (const ch of data?.items || []) {
      if (ch.id) {
        result.set(ch.id, ch);
      }
    }
  }

  return result;
}

/**
 * Rule 3 — 30-Day Regular Video Activity Rule (Excluding Shorts):
 * 1. Try long-form-only playlist UULF{channelId.slice(2)} via playlistItems.list (maxResults=1).
 * 2. If UULF returns an item, check if publishedAt >= thirtyDaysAgoMs.
 * 3. If UULF returns 404 or no items (or channelId doesn't start with UC), fall back to
 *    checking recent uploads from uploads playlist via videos.list (part=contentDetails,snippet)
 *    and exclude videos with duration <= 60 seconds or #shorts tags.
 */
export async function checkRecentLongFormActivity(
  apiKey: string,
  channelId: string,
  uploadsPlaylistId: string | undefined,
  thirtyDaysAgoMs: number,
  onUsage?: YouTubeUsageCallback
): Promise<{ qualified: boolean; latestVideoAt: string | null }> {
  // Primary check: UULF long-form-only playlist
  if (channelId.startsWith('UC') && channelId.length > 2) {
    const uulfPlaylistId = `UULF${channelId.slice(2)}`;
    const uulfData = await fetchYouTubeJson<{
      items?: Array<{
        snippet?: { publishedAt?: string };
        contentDetails?: { videoId?: string; videoPublishedAt?: string };
      }>;
    }>(
      'playlistItems',
      {
        part: 'snippet,contentDetails',
        playlistId: uulfPlaylistId,
        maxResults: '1',
      },
      apiKey,
      { allow404: true, onUsage }
    );

    if (uulfData && Array.isArray(uulfData.items) && uulfData.items.length > 0) {
      const latestItem = uulfData.items[0];
      const publishedAt =
        latestItem.contentDetails?.videoPublishedAt || latestItem.snippet?.publishedAt || null;

      if (!publishedAt) {
        return { qualified: false, latestVideoAt: null };
      }

      const publishedMs = Date.parse(publishedAt);
      if (!Number.isNaN(publishedMs) && publishedMs >= thirtyDaysAgoMs) {
        return { qualified: true, latestVideoAt: publishedAt };
      }

      // UULF is ordered newest-first; if latest long-form video is older than 30 days, channel fails
      return { qualified: false, latestVideoAt: publishedAt };
    }
  }

  // Fallback check: inspect recent uploads playlist items and filter via videos.list
  const fallbackPlaylistId =
    uploadsPlaylistId || (channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : undefined);

  if (!fallbackPlaylistId) {
    return { qualified: false, latestVideoAt: null };
  }

  const uploadsData = await fetchYouTubeJson<{
    items?: Array<{
      snippet?: { publishedAt?: string };
      contentDetails?: { videoId?: string; videoPublishedAt?: string };
    }>;
  }>(
    'playlistItems',
    {
      part: 'snippet,contentDetails',
      playlistId: fallbackPlaylistId,
      maxResults: '15',
    },
    apiKey,
    { allow404: true, onUsage }
  );

  if (!uploadsData || !Array.isArray(uploadsData.items) || uploadsData.items.length === 0) {
    return { qualified: false, latestVideoAt: null };
  }

  const recentVideoIds: string[] = [];
  for (const item of uploadsData.items) {
    const vid = item.contentDetails?.videoId;
    const pubAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
    if (!vid || !pubAt) continue;
    const pubMs = Date.parse(pubAt);
    if (!Number.isNaN(pubMs) && pubMs >= thirtyDaysAgoMs) {
      recentVideoIds.push(vid);
    }
  }

  if (recentVideoIds.length === 0) {
    return { qualified: false, latestVideoAt: null };
  }

  const videosData = await fetchYouTubeJson<{
    items?: Array<{
      id?: string;
      snippet?: {
        publishedAt?: string;
        title?: string;
        description?: string;
        tags?: string[];
      };
      contentDetails?: {
        duration?: string;
      };
    }>;
  }>(
    'videos',
    {
      part: 'contentDetails,snippet',
      id: recentVideoIds.slice(0, 50).join(','),
    },
    apiKey,
    { onUsage }
  );

  for (const video of videosData?.items || []) {
    const pubAt = video.snippet?.publishedAt;
    if (!pubAt) continue;
    const pubMs = Date.parse(pubAt);
    if (Number.isNaN(pubMs) || pubMs < thirtyDaysAgoMs) continue;

    const durationSeconds = parseIso8601DurationToSeconds(video.contentDetails?.duration);
    if (durationSeconds <= 60) continue; // Exclude Shorts (<= 60s)
    if (hasShortsMarker(video.snippet)) continue; // Exclude #shorts tagged videos

    return { qualified: true, latestVideoAt: pubAt };
  }

  return { qualified: false, latestVideoAt: null };
}
