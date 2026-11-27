import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FolderCheck,
  Loader2,
  LogOut,
  Play,
  Square,
  X,
} from 'lucide-react';
import {
  ConfirmActionModal,
  type ConfirmDetailRow,
} from './components/ConfirmActionModal';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { QuotaCard } from './components/QuotaCard';
import { ResultsTable } from './components/ResultsTable';
import { downloadLeadsCsv, formatLocalTimestamp } from './lib/csv';
import {
  clearAccessToken,
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
} from './lib/googleAuth';
import type {
  CountryFilterMode,
  PipelineProgress,
  QualifiedLead,
  RunStopReason,
  RunStreamEvent,
  SavedSheetInfo,
  WorkspaceValidationResult,
  YouTubeQuotaSnapshot,
} from './types/leadpilot';

type RunState = 'idle' | 'validating' | 'running' | 'saving' | 'completed';

interface BannerAlert {
  tone: 'warning' | 'success' | 'info';
  title: string;
  message: string;
}

interface ErrorAlertState {
  title: string;
  message: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const SAVE_PHASE_TIMEOUT_MS = 35_000;

async function fetchWithClientTimeout(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    const detail = err instanceof Error ? err.message : 'Network error';
    throw new Error(`${label} failed: ${detail}`);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function readResponsePayload<T>(res: Response): Promise<{ json: T | null; rawText: string }> {
  const rawText = await res.text();
  if (!rawText.trim()) {
    return { json: null, rawText: '' };
  }
  try {
    return { json: JSON.parse(rawText) as T, rawText };
  } catch {
    return { json: null, rawText };
  }
}

const INITIAL_PROGRESS: PipelineProgress = {
  activeKeyword: '',
  activeKeywordIndex: 0,
  totalKeywords: 0,
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
  targetCount: 0,
  existingDatabaseCount: 0,
};

function parseKeywordsInput(raw: string): string[] {
  const parts = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const seen = new Set<string>();
  const uniqueOrdered: string[] = [];
  for (const kw of parts) {
    if (!seen.has(kw)) {
      seen.add(kw);
      uniqueOrdered.push(kw);
    }
  }
  return uniqueOrdered;
}

function parseCountryCodesInput(raw: string): { valid: string[]; invalid: string[] } {
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  const valid: string[] = [];
  const invalid: string[] = [];

  for (const code of parts) {
    if (/^[A-Z]{2}$/.test(code)) {
      if (!valid.includes(code)) valid.push(code);
    } else {
      invalid.push(code);
    }
  }
  return { valid, invalid };
}

function parseOptionalWholeNumber(
  raw: string,
  minAllowed: number
): { value: number | null; valid: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { value: null, valid: true };
  if (!/^\d+$/.test(trimmed)) return { value: null, valid: false };
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < minAllowed) {
    return { value: null, valid: false };
  }
  return { value: num, valid: true };
}

function formatSubscriberRangeLabel(
  minSubs: number | null,
  maxSubs: number | null
): string {
  if (minSubs === null && maxSubs === null) return 'No limit';
  if (minSubs !== null && maxSubs === null) {
    return `≥ ${minSubs.toLocaleString()} (No max)`;
  }
  if (minSubs === null && maxSubs !== null) {
    return `≤ ${maxSubs.toLocaleString()} (No min)`;
  }
  return `${minSubs!.toLocaleString()} – ${maxSubs!.toLocaleString()}`;
}

function formatRecencyLabel(days: number | null): string {
  if (days === null) return 'Any';
  return `Within ${days.toLocaleString()} ${days === 1 ? 'day' : 'days'} (no Shorts)`;
}

function formatCountryModeLabel(mode: CountryFilterMode): string {
  return mode === 'exclude' ? 'Exclude' : 'Include Only';
}

function formatCountryCodesLabel(mode: CountryFilterMode, codes: string[]): string {
  if (codes.length > 0) return codes.join(', ');
  return mode === 'exclude' ? 'None' : 'Any';
}

function formatCountryFilterSummary(
  mode: CountryFilterMode,
  codes: string[],
  includeMissing: boolean
): string {
  const modeLabel = formatCountryModeLabel(mode);
  const codesLabel = formatCountryCodesLabel(mode, codes);
  const blankLabel = includeMissing ? 'Blank country: Included' : 'Blank country: Excluded';
  return `${modeLabel}: ${codesLabel} · ${blankLabel}`;
}

export default function App() {
  // Google Workspace Auth state
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState<boolean>(true);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // Server capability status
  const [hasServerYoutubeKey, setHasServerYoutubeKey] = useState<boolean | null>(null);
  const [fallbackYoutubeKey, setFallbackYoutubeKey] = useState<string>('');

  // Configuration form inputs (Keywords, Target Count, Subscriber Range, Recency, Country Codes & Tab Name start completely empty)
  const [keywordsText, setKeywordsText] = useState<string>('');
  const [targetCountInput, setTargetCountInput] = useState<string>('');
  const [minSubscribersInput, setMinSubscribersInput] = useState<string>('');
  const [maxSubscribersInput, setMaxSubscribersInput] = useState<string>('');
  const [recencyDaysInput, setRecencyDaysInput] = useState<string>('');
  const [countryFilterMode, setCountryFilterMode] = useState<CountryFilterMode>('exclude');
  const [countryCodesInput, setCountryCodesInput] = useState<string>('');
  const [includeMissingCountry, setIncludeMissingCountry] = useState<boolean>(true);
  const [enableSheetsDedupe, setEnableSheetsDedupe] = useState<boolean>(true);
  const [enableDriveOutput, setEnableDriveOutput] = useState<boolean>(true);
  const [masterSheetInput, setMasterSheetInput] = useState<string>('');
  const [tabNameInput, setTabNameInput] = useState<string>('');
  const [outputFolderInput, setOutputFolderInput] = useState<string>('');

  // Run & workspace state
  const [runState, setRunState] = useState<RunState>('idle');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [activeStopToken, setActiveStopToken] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState<boolean>(false);
  const [validatedWorkspace, setValidatedWorkspace] =
    useState<WorkspaceValidationResult | null>(null);
  const [progress, setProgress] = useState<PipelineProgress>(INITIAL_PROGRESS);
  const [qualifiedLeads, setQualifiedLeads] = useState<QualifiedLead[]>([]);
  const [savedSheet, setSavedSheet] = useState<SavedSheetInfo | null>(null);
  const [lastStopReason, setLastStopReason] = useState<RunStopReason | null>(null);
  const [activeRunRecencyDays, setActiveRunRecencyDays] = useState<number | null>(null);
  const [activeRunEnableSheetsDedupe, setActiveRunEnableSheetsDedupe] = useState<boolean>(true);
  const [activeRunEnableDriveOutput, setActiveRunEnableDriveOutput] = useState<boolean>(true);
  const [statusDetail, setStatusDetail] = useState<string>('');
  const [errorAlert, setErrorAlert] = useState<ErrorAlertState | null>(null);
  const [banner, setBanner] = useState<BannerAlert | null>(null);
  const [quotaSnapshot, setQuotaSnapshot] = useState<YouTubeQuotaSnapshot | null>(null);

  // Explicit confirmation modals for discovery runs & Drive/Sheets creation
  const [pendingStartConfirm, setPendingStartConfirm] =
    useState<{ workspace: WorkspaceValidationResult | null } | null>(null);
  const [showManualSaveConfirm, setShowManualSaveConfirm] = useState<boolean>(false);
  const [isSavingManualSheet, setIsSavingManualSheet] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const runStartLockRef = useRef<boolean>(false);
  const manualSheetSaveLockRef = useRef<boolean>(false);

  const parsedKeywords = useMemo(() => parseKeywordsInput(keywordsText), [keywordsText]);
  const parsedCountries = useMemo(
    () => parseCountryCodesInput(countryCodesInput),
    [countryCodesInput]
  );
  const parsedMinSubs = useMemo(
    () => parseOptionalWholeNumber(minSubscribersInput, 0),
    [minSubscribersInput]
  );
  const parsedMaxSubs = useMemo(
    () => parseOptionalWholeNumber(maxSubscribersInput, 0),
    [maxSubscribersInput]
  );
  const parsedRecencyDays = useMemo(
    () => parseOptionalWholeNumber(recencyDaysInput, 1),
    [recencyDaysInput]
  );

  const subscriberRangeSummary = useMemo(
    () => formatSubscriberRangeLabel(parsedMinSubs.value, parsedMaxSubs.value),
    [parsedMinSubs.value, parsedMaxSubs.value]
  );
  const recencySummary = useMemo(
    () => formatRecencyLabel(parsedRecencyDays.value),
    [parsedRecencyDays.value]
  );
  const countryFilterSummary = useMemo(
    () =>
      formatCountryFilterSummary(
        countryFilterMode,
        parsedCountries.valid,
        includeMissingCountry
      ),
    [countryFilterMode, parsedCountries.valid, includeMissingCountry]
  );

  const refreshServerConfig = useCallback((showErrorOnFailure = false) => {
    fetchWithClientTimeout('/api/config', { method: 'GET' }, 'Backend configuration check')
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Backend /api/config returned HTTP ${res.status}.`);
        }
        const { json } = await readResponsePayload<{
          hasServerYoutubeKey?: boolean;
          quota?: YouTubeQuotaSnapshot;
        }>(res);
        setHasServerYoutubeKey(Boolean(json?.hasServerYoutubeKey));
        if (json?.quota) {
          setQuotaSnapshot(json.quota);
        }
      })
      .catch((err: unknown) => {
        if (showErrorOnFailure) {
          setHasServerYoutubeKey(false);
          const message =
            err instanceof Error ? err.message : 'Could not reach backend server (/api/config).';
          setErrorAlert({
            title: 'Backend Connection Error',
            message,
          });
        }
      });
  }, []);

  // Initialize Firebase Google Auth listener and fetch server YouTube API key capability & quota stats
  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser, token) => {
        setUser(authedUser);
        setAccessToken(token);
        setNeedsAuth(false);
      },
      () => {
        setUser(null);
        setAccessToken(null);
        setNeedsAuth(true);
      }
    );

    refreshServerConfig(true);

    return () => {
      unsubscribe();
      abortControllerRef.current?.abort();
    };
  }, [refreshServerConfig]);

  const handleSignIn = async () => {
    setIsLoggingIn(true);
    setErrorAlert(null);
    setBanner(null);
    try {
      const result = await googleSignIn();
      setUser(result.user);
      setAccessToken(result.accessToken);
      setNeedsAuth(false);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Google sign-in was cancelled or failed.';
      setErrorAlert({
        title: 'Google Sign-In Failed',
        message,
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    setUser(null);
    setAccessToken(null);
    setNeedsAuth(true);
    setValidatedWorkspace(null);
  };

  const handleAuthExpired = (message: string) => {
    clearAccessToken();
    setAccessToken(null);
    setNeedsAuth(true);
    setErrorAlert({
      title: 'Google Workspace Session Expired',
      message,
    });
  };

  const requiresWorkspaceAuth = enableSheetsDedupe || enableDriveOutput;

  const validateFormBasics = (): { ok: boolean; targetCount: number } => {
    const token = getAccessToken() || accessToken;
    if (requiresWorkspaceAuth && !token) {
      setNeedsAuth(true);
      setErrorAlert({
        title: 'Google Workspace Sign-In Required',
        message:
          'Sign in with Google while Google Sheets Deduplication or Google Drive Output is ON, or toggle both OFF to run with YouTube Data API v3 only.',
      });
      return { ok: false, targetCount: 0 };
    }

    if (parsedKeywords.length === 0) {
      setErrorAlert({
        title: 'Missing Keywords',
        message: 'Enter at least one keyword (comma- or newline-separated) to search YouTube.',
      });
      return { ok: false, targetCount: 0 };
    }

    const trimmedTarget = targetCountInput.trim();
    const targetCount = /^\d+$/.test(trimmedTarget) ? Number(trimmedTarget) : NaN;
    if (!trimmedTarget || !Number.isInteger(targetCount) || targetCount < 1 || targetCount > 5000) {
      setErrorAlert({
        title: 'Invalid Target Qualified Leads',
        message: 'Enter a Target Qualified Leads count as a whole number between 1 and 5,000.',
      });
      return { ok: false, targetCount: 0 };
    }

    if (!parsedMinSubs.valid) {
      setErrorAlert({
        title: 'Invalid Min Subscribers',
        message: 'Min Subscribers must be a non-negative whole number, or left blank for no minimum.',
      });
      return { ok: false, targetCount };
    }

    if (!parsedMaxSubs.valid) {
      setErrorAlert({
        title: 'Invalid Max Subscribers',
        message: 'Max Subscribers must be a non-negative whole number, or left blank for no maximum.',
      });
      return { ok: false, targetCount };
    }

    if (
      parsedMinSubs.value !== null &&
      parsedMaxSubs.value !== null &&
      parsedMinSubs.value > parsedMaxSubs.value
    ) {
      setErrorAlert({
        title: 'Invalid Subscriber Range',
        message: 'Min Subscribers cannot be greater than Max Subscribers.',
      });
      return { ok: false, targetCount };
    }

    if (!parsedRecencyDays.valid) {
      setErrorAlert({
        title: 'Invalid Last Long-Form Upload (Days)',
        message:
          'Last Long-Form Upload (Days) must be a positive integer of at least 1, or left blank for no recency restriction.',
      });
      return { ok: false, targetCount };
    }

    if (parsedCountries.invalid.length > 0) {
      setErrorAlert({
        title: 'Invalid Country Code',
        message: `Use 2-letter ISO 3166-1 alpha-2 country codes separated by commas. Invalid entries: ${parsedCountries.invalid.join(', ')}.`,
      });
      return { ok: false, targetCount };
    }

    if (enableSheetsDedupe) {
      if (!masterSheetInput.trim()) {
        setErrorAlert({
          title: 'Missing Master Database Sheet',
          message:
            'Master Database Google Sheet URL or ID is required while Google Sheets Deduplication is ON.',
        });
        return { ok: false, targetCount };
      }

      if (!tabNameInput.trim()) {
        setErrorAlert({
          title: 'Missing Deduplication Tab Name',
          message:
            'Deduplication Tab Name (e.g. Database) is required while Google Sheets Deduplication is ON.',
        });
        return { ok: false, targetCount };
      }
    }

    if (enableDriveOutput && !outputFolderInput.trim()) {
      setErrorAlert({
        title: 'Missing Output Drive Folder',
        message:
          'Output Google Drive Folder URL or ID is required while Google Drive Output is ON.',
      });
      return { ok: false, targetCount };
    }

    if (hasServerYoutubeKey === false && !fallbackYoutubeKey.trim()) {
      setErrorAlert({
        title: 'YouTube Data API Key Required',
        message:
          'Configure YOUTUBE_API_KEY in server Secrets or enter a fallback YouTube Data API v3 key below.',
      });
      return { ok: false, targetCount };
    }

    return { ok: true, targetCount };
  };

  const runWorkspaceValidation = async (): Promise<WorkspaceValidationResult | null> => {
    const token = getAccessToken() || accessToken;
    if (!token) {
      setNeedsAuth(true);
      setErrorAlert({
        title: 'Google Workspace Sign-In Required',
        message: 'Sign in with Google before verifying your enabled Google Workspace links.',
      });
      return null;
    }

    setRunState('validating');
    setErrorAlert(null);
    setBanner(null);

    try {
      const res = await fetchWithClientTimeout(
        '/api/validate-workspace',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            enableSheetsDedupe,
            enableDriveOutput,
            masterSheetInput: enableSheetsDedupe ? masterSheetInput.trim() : '',
            tabName: enableSheetsDedupe ? tabNameInput.trim() : '',
            outputFolderInput: enableDriveOutput ? outputFolderInput.trim() : '',
          }),
        },
        'Google Sheets & Drive validation'
      );

      const { json: data, rawText } = await readResponsePayload<{
        workspace?: WorkspaceValidationResult;
        error?: string;
        code?: string;
      }>(res);

      if (res.status === 401 || data?.code === 'AUTH_EXPIRED') {
        handleAuthExpired(
          data?.error || 'Your Google Workspace session expired. Please sign in again.'
        );
        setRunState('idle');
        return null;
      }

      if (!res.ok || !data?.workspace) {
        const fallbackDetail = rawText.trim().slice(0, 200) || `HTTP ${res.status}`;
        setErrorAlert({
          title: 'Workspace Validation Failed',
          message: data?.error || `Could not validate Google Workspace links (${fallbackDetail}).`,
        });
        setRunState('idle');
        return null;
      }

      setValidatedWorkspace(data.workspace);
      setRunState('idle');
      return data.workspace;
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Network error while validating Google Workspace links.';
      setErrorAlert({
        title: 'Validation Request Failed',
        message,
      });
      setRunState('idle');
      return null;
    }
  };

  const handleVerifyOnly = async () => {
    if (!enableSheetsDedupe && !enableDriveOutput) {
      setErrorAlert({
        title: 'No Google Workspace Links Enabled',
        message:
          'Enable Google Sheets Deduplication or Google Drive Output before verifying Workspace links.',
      });
      return;
    }

    if (enableSheetsDedupe) {
      if (!masterSheetInput.trim()) {
        setErrorAlert({
          title: 'Missing Master Database Sheet',
          message:
            'Enter the Master Database Google Sheet URL or ID before verifying links.',
        });
        return;
      }
      if (!tabNameInput.trim()) {
        setErrorAlert({
          title: 'Missing Deduplication Tab Name',
          message:
            'Enter the Deduplication Tab Name (e.g. Database) before verifying links.',
        });
        return;
      }
    }

    if (enableDriveOutput && !outputFolderInput.trim()) {
      setErrorAlert({
        title: 'Missing Output Drive Folder',
        message: 'Enter the Output Google Drive Folder URL or ID before verifying links.',
      });
      return;
    }

    const result = await runWorkspaceValidation();
    if (result) {
      const verifiedParts: string[] = [];
      if (result.sheetsEnabled) {
        verifiedParts.push(
          `Master Sheet "${result.spreadsheetTitle}" (${result.tabName} tab, ${result.existingChannelsCount.toLocaleString()} existing channel names in ${result.channelNameColumn})`
        );
      }
      if (result.driveEnabled) {
        verifiedParts.push(`output folder "${result.folderName}"`);
      }
      setBanner({
        tone: 'info',
        title: 'Google Workspace Links Verified',
        message: `Connected to ${verifiedParts.join(' and ')}.`,
      });
    }
  };

  const handleValidateAndPrepareRun = async (e: React.FormEvent) => {
    e.preventDefault();
    if (runStartLockRef.current || isBusy) return;

    const check = validateFormBasics();
    if (!check.ok) return;

    if (enableSheetsDedupe || enableDriveOutput) {
      runStartLockRef.current = true;
      try {
        const workspace = await runWorkspaceValidation();
        if (!workspace) return;
        setPendingStartConfirm({ workspace });
      } finally {
        runStartLockRef.current = false;
      }
    } else {
      setErrorAlert(null);
      setBanner(null);
      setPendingStartConfirm({ workspace: null });
    }
  };

  const executeConfirmedRun = async () => {
    if (runStartLockRef.current || isBusy) return;
    const pending = pendingStartConfirm;
    setPendingStartConfirm(null);
    if (!pending) return;

    const workspace = pending.workspace;
    const token = getAccessToken() || accessToken;
    if ((enableSheetsDedupe || enableDriveOutput) && !token) {
      handleAuthExpired('Please sign in with Google before starting the run.');
      return;
    }

    runStartLockRef.current = true;
    const targetCount = Number(targetCountInput.trim());
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setRunState('running');
    setIsStopping(false);
    setActiveRunId(null);
    setActiveStopToken(null);
    setQualifiedLeads([]);
    setSavedSheet(null);
    setLastStopReason(null);
    setActiveRunRecencyDays(parsedRecencyDays.value);
    setActiveRunEnableSheetsDedupe(enableSheetsDedupe);
    setActiveRunEnableDriveOutput(enableDriveOutput);
    setStatusDetail('Connecting to discovery pipeline...');
    setErrorAlert(null);
    setBanner(null);
    setProgress({
      ...INITIAL_PROGRESS,
      activeKeyword: parsedKeywords[0] || '',
      activeKeywordIndex: 1,
      totalKeywords: parsedKeywords.length,
      targetCount,
      existingDatabaseCount: workspace?.sheetsEnabled ? workspace.existingChannelsCount : 0,
    });
    setQuotaSnapshot((prev) =>
      prev
        ? {
            ...prev,
            runSearchCalls: 0,
            runReadUnits: 0,
          }
        : prev
    );

    // 15-second inactivity watchdog during discovery; extended timeout during final Google Sheet saving
    let timedOutReason: string | null = null;
    let watchdogTimer: number | null = null;
    let receivedTerminalEvent = false;
    let isSavingPhase = false;

    const resetWatchdog = (stageDescription: string, timeoutMs = REQUEST_TIMEOUT_MS) => {
      if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
      }
      watchdogTimer = window.setTimeout(() => {
        timedOutReason = `Request timed out after ${Math.round(timeoutMs / 1000)} seconds (${stageDescription}).`;
        controller.abort();
      }, timeoutMs);
    };

    const clearWatchdog = () => {
      if (watchdogTimer !== null) {
        window.clearTimeout(watchdogTimer);
        watchdogTimer = null;
      }
    };

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      if (hasServerYoutubeKey === false && fallbackYoutubeKey.trim()) {
        headers['X-YouTube-API-Key'] = fallbackYoutubeKey.trim();
      }

      resetWatchdog('waiting for backend /api/runs/start response');

      const res = await fetch('/api/runs/start', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          keywords: parsedKeywords,
          targetCount,
          minSubscribers: parsedMinSubs.value,
          maxSubscribers: parsedMaxSubs.value,
          recencyDays: parsedRecencyDays.value,
          countryFilterMode,
          countryCodes: parsedCountries.valid,
          includeMissingCountry,
          enableSheetsDedupe,
          enableDriveOutput,
          masterSheetInput: enableSheetsDedupe ? masterSheetInput.trim() : '',
          tabName: enableSheetsDedupe ? tabNameInput.trim() : '',
          outputFolderInput: enableDriveOutput ? outputFolderInput.trim() : '',
          tzOffsetMinutes: new Date().getTimezoneOffset(),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        clearWatchdog();
        const { json: errJson, rawText } = await readResponsePayload<{ error?: string }>(res);
        const errorMessage =
          errJson?.error ||
          (rawText.trim() ? rawText.trim().slice(0, 300) : `Backend /api/runs/start failed with HTTP ${res.status}.`);
        if (res.status === 401) {
          handleAuthExpired(errorMessage);
        } else {
          setErrorAlert({
            title: `Discovery Request Failed (HTTP ${res.status})`,
            message: errorMessage,
          });
        }
        setRunState('idle');
        setStatusDetail('');
        return;
      }

      if (!res.body) {
        clearWatchdog();
        throw new Error('Backend returned an empty streaming response body.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleEvent = (event: RunStreamEvent) => {
        switch (event.type) {
          case 'status':
            setStatusDetail(event.message);
            break;

          case 'init':
            setActiveRunId(event.runId);
            setActiveStopToken(event.stopToken || null);
            setValidatedWorkspace(event.workspace);
            setStatusDetail('');
            if (event.quota) {
              setQuotaSnapshot(event.quota);
            }
            break;

          case 'progress':
            setStatusDetail('');
            setProgress(event.progress);
            if (event.quota) {
              setQuotaSnapshot(event.quota);
            }
            break;

          case 'lead':
            setStatusDetail('');
            setQualifiedLeads((prev) => [...prev, event.lead]);
            setProgress(event.progress);
            if (event.quota) {
              setQuotaSnapshot(event.quota);
            }
            break;

          case 'saving':
            isSavingPhase = true;
            setRunState('saving');
            setStatusDetail(event.message);
            setProgress(event.progress);
            setBanner({
              tone: 'info',
              title: 'Saving Standalone Google Sheet',
              message: event.message,
            });
            break;

          case 'complete': {
            receivedTerminalEvent = true;
            setProgress(event.progress);
            if (event.quota) {
              setQuotaSnapshot(event.quota);
            }
            setLastStopReason(event.reason);
            setSavedSheet(event.savedSheet);
            setRunState('completed');
            setActiveRunId(null);
            setActiveStopToken(null);
            setIsStopping(false);
            setStatusDetail('');

            // Surface any API / quota / network / sheet-save error prominently in the red alert box above the progress bar
            if (event.errorMessage || event.saveError || event.reason === 'network_error' || event.reason === 'quota_exceeded') {
              const combinedParts: string[] = [];
              if (event.errorMessage) {
                combinedParts.push(event.errorMessage);
              } else if (event.reason === 'network_error' || event.reason === 'quota_exceeded') {
                combinedParts.push(event.message);
              }
              if (event.saveError) {
                combinedParts.push(`Google Sheet save error: ${event.saveError}`);
              }

              if (event.saveErrorCode === 'AUTH_EXPIRED') {
                handleAuthExpired(combinedParts.join(' — '));
              } else {
                setErrorAlert({
                  title:
                    event.reason === 'quota_exceeded'
                      ? 'YouTube Data API Daily Quota Reached'
                      : event.saveError && !event.errorMessage
                        ? 'Google Sheet Save Failed'
                        : 'Discovery Pipeline Error',
                  message: combinedParts.join(' — '),
                });
              }
            }

            if (event.savedSheet) {
              setBanner({
                tone: event.reason === 'target_reached' ? 'success' : 'info',
                title:
                  event.reason === 'target_reached'
                    ? 'Target Reached & Saved to Google Drive'
                    : 'Partial Batch Saved to Google Drive',
                message: `Created standalone Google Sheet "${event.savedSheet.fileName}" inside "${workspace?.folderName || 'your target folder'}" with ${event.savedSheet.rowCount} qualified lead${event.savedSheet.rowCount === 1 ? '' : 's'}.`,
              });
            } else if (event.reason === 'target_reached') {
              setBanner({
                tone: 'success',
                title: 'Target Reached — Ready for CSV Export',
                message: `${event.message} Google Drive Output is OFF — use Download CSV to export your leads.`,
              });
            } else if (event.reason === 'keywords_exhausted') {
              setBanner({
                tone: event.progress.qualifiedCount > 0 ? 'warning' : 'info',
                title: 'All Keywords Exhausted',
                message: event.message,
              });
            } else if (event.reason === 'user_stopped') {
              setBanner({
                tone: 'info',
                title: 'Discovery Run Stopped',
                message: event.message,
              });
            }
            break;
          }

          case 'error':
            receivedTerminalEvent = true;
            setRunState('idle');
            setActiveRunId(null);
            setActiveStopToken(null);
            setIsStopping(false);
            setStatusDetail('');
            if (event.code === 'AUTH_EXPIRED') {
              handleAuthExpired(event.message);
            } else {
              setErrorAlert({
                title: 'Discovery Error',
                message: event.message,
              });
            }
            break;
        }
      };

      while (true) {
        resetWatchdog(
          isSavingPhase
            ? 'saving qualified leads to Google Sheet'
            : 'waiting for next update from YouTube / Google Sheets pipeline',
          isSavingPhase ? SAVE_PHASE_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        );
        const { done, value } = await reader.read();
        if (done) {
          clearWatchdog();
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as RunStreamEvent;
            handleEvent(parsed);
          } catch {
            // Skip malformed partial chunk
          }
        }
      }

      if (buffer.trim()) {
        try {
          handleEvent(JSON.parse(buffer.trim()) as RunStreamEvent);
        } catch {
          // Ignore trailing noise
        }
      }

      if (!receivedTerminalEvent) {
        setRunState('idle');
        setActiveRunId(null);
        setActiveStopToken(null);
        setIsStopping(false);
        setStatusDetail('');
        setErrorAlert({
          title: 'Discovery Stream Closed Unexpectedly',
          message:
            'The backend connection ended before returning a completion or error response. Verify your YouTube API key, Google Sheets permissions, and try again.',
        });
      }
    } catch (err: unknown) {
      clearWatchdog();
      if (timedOutReason) {
        setErrorAlert({
          title: 'Discovery Request Timed Out',
          message: timedOutReason,
        });
      } else if ((err as { name?: string })?.name !== 'AbortError') {
        const message =
          err instanceof Error ? err.message : 'Connection lost during discovery run.';
        setErrorAlert({
          title: 'Discovery Connection Failed',
          message,
        });
      }
      setRunState((prev) => (prev === 'completed' ? prev : 'idle'));
      setActiveRunId(null);
      setActiveStopToken(null);
      setIsStopping(false);
      setStatusDetail('');
    } finally {
      clearWatchdog();
      abortControllerRef.current = null;
      runStartLockRef.current = false;
    }
  };

  const handleStopRun = async () => {
    const token = getAccessToken() || accessToken;
    if (!activeRunId || (!token && !activeStopToken)) {
      abortControllerRef.current?.abort();
      setRunState('idle');
      setStatusDetail('');
      return;
    }

    setIsStopping(true);
    try {
      const stopHeaders: Record<string, string> = {};
      if (token) {
        stopHeaders.Authorization = `Bearer ${token}`;
      }
      if (activeStopToken) {
        stopHeaders['X-Run-Stop-Token'] = activeStopToken;
      }

      const res = await fetchWithClientTimeout(
        `/api/runs/${encodeURIComponent(activeRunId)}/stop`,
        {
          method: 'POST',
          headers: stopHeaders,
        },
        'Stop discovery run'
      );
      if (res.status === 404) {
        // Run already finished or entered final cleanup milliseconds earlier — keep stream open to receive the final completion & saved Sheet link
        return;
      }
      if (!res.ok) {
        const { json } = await readResponsePayload<{ error?: string }>(res);
        throw new Error(json?.error || `Stop request returned HTTP ${res.status}.`);
      }
    } catch (err: unknown) {
      abortControllerRef.current?.abort();
      setIsStopping(false);
      setRunState('idle');
      setStatusDetail('');
      const message = err instanceof Error ? err.message : 'Failed to stop discovery run cleanly.';
      setErrorAlert({
        title: 'Stop Run Failed',
        message,
      });
    }
  };

  const handleManualSaveSheet = async () => {
    if (manualSheetSaveLockRef.current || isSavingManualSheet) return;

    const token = getAccessToken() || accessToken;
    if (!token) {
      setShowManualSaveConfirm(false);
      handleAuthExpired('Please sign in with Google to save leads to a new Google Sheet.');
      return;
    }

    manualSheetSaveLockRef.current = true;
    setIsSavingManualSheet(true);
    setErrorAlert(null);
    try {
      const res = await fetchWithClientTimeout(
        '/api/sheets/save',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            outputFolderInput,
            leads: qualifiedLeads.map((l) => ({
              channelName: l.channelName,
              channelUrl: l.channelUrl,
            })),
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          }),
        },
        'Google Sheets save'
      );

      const { json: data, rawText } = await readResponsePayload<{
        savedSheet?: SavedSheetInfo;
        error?: string;
        code?: string;
      }>(res);

      if (res.status === 401 || data?.code === 'AUTH_EXPIRED') {
        setShowManualSaveConfirm(false);
        handleAuthExpired(data?.error || 'Google session expired. Sign in again to save.');
        return;
      }

      if (!res.ok || !data?.savedSheet) {
        const fallbackDetail = rawText.trim().slice(0, 200) || `HTTP ${res.status}`;
        setErrorAlert({
          title: 'Could Not Create Google Sheet',
          message: data?.error || `Failed to save leads to a new Google Sheet (${fallbackDetail}).`,
        });
        setShowManualSaveConfirm(false);
        return;
      }

      setSavedSheet(data.savedSheet);
      setShowManualSaveConfirm(false);
      setBanner({
        tone: 'success',
        title: 'Standalone Google Sheet Created',
        message: `Saved ${data.savedSheet.rowCount} qualified leads into "${data.savedSheet.fileName}".`,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Network error while saving Google Sheet.';
      setErrorAlert({
        title: 'Google Sheet Save Failed',
        message,
      });
      setShowManualSaveConfirm(false);
    } finally {
      manualSheetSaveLockRef.current = false;
      setIsSavingManualSheet(false);
    }
  };

  const isBusy = runState === 'validating' || runState === 'running' || runState === 'saving';
  const progressPercent =
    progress.targetCount > 0
      ? Math.min(100, Math.round((progress.qualifiedCount / progress.targetCount) * 100))
      : 0;

  const startConfirmDetails: ConfirmDetailRow[] = pendingStartConfirm
    ? [
        {
          label: 'Google Sheets Deduplication',
          value:
            enableSheetsDedupe && pendingStartConfirm.workspace?.sheetsEnabled
              ? `ON · ${pendingStartConfirm.workspace.spreadsheetTitle} — ${pendingStartConfirm.workspace.tabName} (${pendingStartConfirm.workspace.existingChannelsCount.toLocaleString()} channels, ${pendingStartConfirm.workspace.channelNameColumn})`
              : 'OFF · Master Sheet deduplication skipped',
        },
        {
          label: 'Google Drive Output',
          value:
            enableDriveOutput && pendingStartConfirm.workspace?.driveEnabled
              ? `ON · ${pendingStartConfirm.workspace.folderName} → YouTube Leads - ${formatLocalTimestamp()}`
              : 'OFF · CSV export only (no Google Sheet created)',
        },
        {
          label: 'Keywords & Target',
          value: `${parsedKeywords.length} keyword${parsedKeywords.length === 1 ? '' : 's'} · Target ${Number(targetCountInput.trim()).toLocaleString()} leads`,
        },
        {
          label: 'Subscriber Range',
          value: `${subscriberRangeSummary} · Hidden counts skipped`,
        },
        {
          label: 'Country Filter',
          value: countryFilterSummary,
        },
        {
          label: 'Last Long-Form Upload',
          value: recencySummary,
        },
      ]
    : [];

  const manualSaveDetails: ConfirmDetailRow[] = [
    {
      label: 'New Standalone Sheet',
      value: `YouTube Leads - ${formatLocalTimestamp()}`,
    },
    {
      label: 'Destination Folder',
      value: validatedWorkspace?.folderName || outputFolderInput.trim(),
    },
    {
      label: 'Rows to Write (RAW)',
      value: `${qualifiedLeads.length.toLocaleString()} leads + 1 header row (Channel Name, Channel URL)`,
    },
    {
      label: 'Existing Sheets',
      value: 'Unchanged (creates a brand-new spreadsheet)',
    },
  ];

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      {/* Top Navigation Bar — Strict 3-Zone Contract */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
        <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <a
            href="#discovery"
            className="text-lg font-bold tracking-tight text-slate-950 whitespace-nowrap shrink-0"
          >
            YouTube LeadPilot
          </a>

          {/* Zone 2: Concise Single-Line Text Navigation */}
          <nav
            aria-label="Primary"
            className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-600"
          >
            <a
              href="#discovery"
              className="hover:text-slate-950 transition-colors whitespace-nowrap shrink-0"
            >
              Discovery
            </a>
            <a
              href="#qualified-leads"
              className="hover:text-slate-950 transition-colors whitespace-nowrap shrink-0"
            >
              Qualified Leads
            </a>
            <a
              href="#qualification-rules"
              className="hover:text-slate-950 transition-colors whitespace-nowrap shrink-0"
            >
              Qualification Rules
            </a>
          </nav>

          {/* Zone 3: Single Primary Auth Control */}
          <div className="flex items-center gap-3 shrink-0">
            {needsAuth || !user ? (
              <GoogleSignInButton
                onClick={handleSignIn}
                disabled={isLoggingIn}
                label={isLoggingIn ? 'Signing in...' : 'Sign in with Google'}
              />
            ) : (
              <div className="flex items-center gap-3">
                <span className="hidden sm:inline text-xs font-medium text-slate-600 max-w-[190px] truncate">
                  {user.email || user.displayName}
                </span>
                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={isBusy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-slate-900 disabled:opacity-50"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main
        id="discovery"
        className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-8 space-y-8"
      >
        {/* Page Heading */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="text-2xl font-bold tracking-tight text-slate-950 [text-wrap:balance]">
              Channel Discovery &amp; Qualification
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              Discover active YouTube creators by keyword, filter by custom criteria, optionally deduplicate against an existing database, and export to Google Sheets or CSV.
            </p>
          </div>
          {validatedWorkspace && (validatedWorkspace.sheetsEnabled || validatedWorkspace.driveEnabled) && (
            <div className="flex items-center gap-2 text-xs text-slate-600 whitespace-nowrap shrink-0">
              <FolderCheck className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>
                Verified:{' '}
                {validatedWorkspace.sheetsEnabled && (
                  <>
                    {validatedWorkspace.spreadsheetTitle} ({validatedWorkspace.tabName})
                  </>
                )}
                {validatedWorkspace.sheetsEnabled && validatedWorkspace.driveEnabled && (
                  <span aria-hidden="true" className="mx-1.5">
                    ·
                  </span>
                )}
                {validatedWorkspace.driveEnabled && (
                  <>Folder: {validatedWorkspace.folderName}</>
                )}
              </span>
            </div>
          )}
        </div>

        {/* Two-Column Operational Split */}
        <div className="grid grid-cols-1 lg:grid-cols-[410px_minmax(0,1fr)] gap-6 items-start">
          {/* Left Column: Configuration Panel */}
          <form
            noValidate
            onSubmit={handleValidateAndPrepareRun}
            className="bg-white border border-slate-200 rounded-lg overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <h2 className="text-base font-semibold text-slate-900 tracking-tight">
                Run Configuration
              </h2>
              <span className="text-xs text-slate-500 whitespace-nowrap">
                {!enableSheetsDedupe && !enableDriveOutput
                  ? 'YouTube-only mode'
                  : needsAuth
                    ? 'Google not connected'
                    : 'Workspace connected'}
              </span>
            </div>

            <div className="p-6 space-y-5 divide-y divide-slate-100">
              {/* 1. Keywords (Mandatory — Empty by Default) */}
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <label
                    htmlFor="keywords-input"
                    className="block text-sm font-medium text-slate-900"
                  >
                    Keywords
                  </label>
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {parsedKeywords.length} queued
                  </span>
                </div>
                <textarea
                  id="keywords-input"
                  rows={4}
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  disabled={isBusy}
                  placeholder={'make money online\nai automation\necommerce'}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500"
                />
                <p className="text-xs text-slate-500">
                  Required. Single or multiple keywords separated by commas or new lines, processed strictly in order.
                </p>
              </div>

              {/* 2. Target Qualified Leads (Mandatory — Empty by Default) */}
              <div className="pt-5 space-y-1.5">
                <label
                  htmlFor="target-count-input"
                  className="block text-sm font-medium text-slate-900"
                >
                  Target Qualified Leads
                </label>
                <input
                  id="target-count-input"
                  type="number"
                  min={1}
                  max={5000}
                  step={1}
                  value={targetCountInput}
                  onChange={(e) => setTargetCountInput(e.target.value)}
                  disabled={isBusy}
                  placeholder="100"
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500"
                />
                <p className="text-xs text-slate-500">
                  Required. Whole number between 1 and 5,000.
                </p>
              </div>

              {/* 2a. Country Filter (Mode Toggle, Blank-by-Default Codes, Blank-Country Switch) */}
              <div className="pt-5 space-y-3.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-slate-900">
                    Country Filter Mode
                  </span>
                  <div
                    role="group"
                    aria-label="Country Filter Mode"
                    className="inline-flex rounded-md border border-slate-300 bg-slate-50 p-0.5 shrink-0"
                  >
                    <button
                      type="button"
                      onClick={() => setCountryFilterMode('exclude')}
                      disabled={isBusy}
                      aria-pressed={countryFilterMode === 'exclude'}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-slate-900 disabled:opacity-50 ${
                        countryFilterMode === 'exclude'
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Exclude
                    </button>
                    <button
                      type="button"
                      onClick={() => setCountryFilterMode('include')}
                      disabled={isBusy}
                      aria-pressed={countryFilterMode === 'include'}
                      className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-slate-900 disabled:opacity-50 ${
                        countryFilterMode === 'include'
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Include Only
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="country-codes-input"
                    className="block text-sm font-medium text-slate-900"
                  >
                    Country Codes
                  </label>
                  <input
                    id="country-codes-input"
                    type="text"
                    value={countryCodesInput}
                    onChange={(e) => setCountryCodesInput(e.target.value)}
                    disabled={isBusy}
                    placeholder={countryFilterMode === 'exclude' ? 'PK, IN, BD' : 'US, GB, CA'}
                    className="w-full px-3 py-2 text-sm font-mono uppercase bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500"
                  />
                  <p className="text-xs text-slate-500">
                    {countryFilterMode === 'exclude'
                      ? 'ISO 3166-1 alpha-2 codes to block. Leave blank to allow all countries.'
                      : 'ISO 3166-1 alpha-2 codes to require. Leave blank to apply no listed-country restriction.'}
                  </p>
                </div>

                <div className="flex items-start justify-between gap-3 pt-1">
                  <div className="min-w-0">
                    <label
                      htmlFor="include-missing-country-switch"
                      className="block text-xs font-medium text-slate-900 cursor-pointer"
                    >
                      Include Channels Without Listed Country
                    </label>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                      {includeMissingCountry
                        ? 'Channels with a blank/missing country remain eligible.'
                        : 'Channels with a blank/missing country are skipped under geo.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 pt-0.5">
                    <span className="text-[11px] font-mono font-semibold text-slate-700 w-6 text-right">
                      {includeMissingCountry ? 'ON' : 'OFF'}
                    </span>
                    <button
                      id="include-missing-country-switch"
                      type="button"
                      role="switch"
                      aria-checked={includeMissingCountry}
                      onClick={() => setIncludeMissingCountry((prev) => !prev)}
                      disabled={isBusy}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50 ${
                        includeMissingCountry ? 'bg-slate-900' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                          includeMissingCountry ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              {/* 2b. Editable Subscriber Range & Last Long-Form Upload Recency (All Blank by Default) */}
              <div className="pt-5 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label
                      htmlFor="min-subscribers-input"
                      className="block text-sm font-medium text-slate-900"
                    >
                      Min Subscribers
                    </label>
                    <input
                      id="min-subscribers-input"
                      type="number"
                      min={0}
                      step={1}
                      value={minSubscribersInput}
                      onChange={(e) => setMinSubscribersInput(e.target.value)}
                      disabled={isBusy}
                      placeholder="1000"
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="max-subscribers-input"
                      className="block text-sm font-medium text-slate-900"
                    >
                      Max Subscribers
                    </label>
                    <input
                      id="max-subscribers-input"
                      type="number"
                      min={0}
                      step={1}
                      value={maxSubscribersInput}
                      onChange={(e) => setMaxSubscribersInput(e.target.value)}
                      disabled={isBusy}
                      placeholder="200000"
                      className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500"
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  Leave blank for no minimum or maximum. Channels with hidden subscriber counts are always skipped.
                </p>

                <div className="space-y-1.5">
                  <label
                    htmlFor="recency-days-input"
                    className="block text-sm font-medium text-slate-900"
                  >
                    Last Long-Form Upload (Days)
                  </label>
                  <input
                    id="recency-days-input"
                    type="number"
                    min={1}
                    step={1}
                    value={recencyDaysInput}
                    onChange={(e) => setRecencyDaysInput(e.target.value)}
                    disabled={isBusy}
                    placeholder="30"
                    className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500"
                  />
                  <p className="text-xs text-slate-500">
                    Leave blank for no recency restriction. When filled (≥ 1), requires at least one non-Shorts long-form video within that window.
                  </p>
                </div>
              </div>

              {/* 3. Google Sheets Deduplication (Optional Toggle — Default ON) */}
              <div className="pt-5 space-y-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <label
                      htmlFor="sheets-dedupe-switch"
                      className="block text-sm font-medium text-slate-900 cursor-pointer"
                    >
                      Google Sheets Deduplication
                    </label>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                      {enableSheetsDedupe
                        ? 'Required below: skips channels already in your Master Sheet tab.'
                        : 'OFF — Master Sheet deduplication is skipped during discovery.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 pt-0.5">
                    <span className="text-[11px] font-mono font-semibold text-slate-700 w-6 text-right">
                      {enableSheetsDedupe ? 'ON' : 'OFF'}
                    </span>
                    <button
                      id="sheets-dedupe-switch"
                      type="button"
                      role="switch"
                      aria-checked={enableSheetsDedupe}
                      onClick={() => {
                        setEnableSheetsDedupe((prev) => !prev);
                        setValidatedWorkspace(null);
                      }}
                      disabled={isBusy}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50 ${
                        enableSheetsDedupe ? 'bg-slate-900' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                          enableSheetsDedupe ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div
                  className={`space-y-3 transition-opacity ${
                    enableSheetsDedupe ? 'opacity-100' : 'opacity-50'
                  }`}
                >
                  <div className="space-y-1.5">
                    <label
                      htmlFor="master-sheet-input"
                      className="block text-xs font-medium text-slate-900"
                    >
                      Master Database Google Sheet
                    </label>
                    <input
                      id="master-sheet-input"
                      type="text"
                      value={masterSheetInput}
                      onChange={(e) => {
                        setMasterSheetInput(e.target.value);
                        setValidatedWorkspace(null);
                      }}
                      disabled={isBusy || !enableSheetsDedupe}
                      placeholder="https://docs.google.com/spreadsheets/d/... or Sheet ID"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label
                      htmlFor="tab-name-input"
                      className="block text-xs font-medium text-slate-900"
                    >
                      Deduplication Tab Name
                    </label>
                    <input
                      id="tab-name-input"
                      type="text"
                      value={tabNameInput}
                      onChange={(e) => {
                        setTabNameInput(e.target.value);
                        setValidatedWorkspace(null);
                      }}
                      disabled={isBusy || !enableSheetsDedupe}
                      placeholder="Database"
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed"
                    />
                    <p className="text-xs text-slate-500">
                      Read-only lookup against Column A (Channel Name) in the specified tab. Never modified.
                    </p>
                  </div>
                </div>
              </div>

              {/* 4. Google Drive Output (Optional Toggle — Default ON) */}
              <div className="pt-5 space-y-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <label
                      htmlFor="drive-output-switch"
                      className="block text-sm font-medium text-slate-900 cursor-pointer"
                    >
                      Google Drive Output
                    </label>
                    <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                      {enableDriveOutput
                        ? 'Required below: creates a standalone Google Sheet when each run finishes.'
                        : 'OFF — skips Google Sheet creation; export results with Download CSV.'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 pt-0.5">
                    <span className="text-[11px] font-mono font-semibold text-slate-700 w-6 text-right">
                      {enableDriveOutput ? 'ON' : 'OFF'}
                    </span>
                    <button
                      id="drive-output-switch"
                      type="button"
                      role="switch"
                      aria-checked={enableDriveOutput}
                      onClick={() => {
                        setEnableDriveOutput((prev) => !prev);
                        setValidatedWorkspace(null);
                      }}
                      disabled={isBusy}
                      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-50 ${
                        enableDriveOutput ? 'bg-slate-900' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                          enableDriveOutput ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div
                  className={`space-y-1.5 transition-opacity ${
                    enableDriveOutput ? 'opacity-100' : 'opacity-50'
                  }`}
                >
                  <label
                    htmlFor="output-folder-input"
                    className="block text-xs font-medium text-slate-900"
                  >
                    Output Google Drive Folder
                  </label>
                  <input
                    id="output-folder-input"
                    type="text"
                    value={outputFolderInput}
                    onChange={(e) => {
                      setOutputFolderInput(e.target.value);
                      setValidatedWorkspace(null);
                    }}
                    disabled={isBusy || !enableDriveOutput}
                    placeholder="https://drive.google.com/drive/folders/... or Folder ID"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed"
                  />
                  <p className="text-xs text-slate-500">
                    Every completed run creates a brand-new standalone spreadsheet named{' '}
                    <span className="font-mono text-slate-700">YouTube Leads - YYYY-MM-DD HH-mm</span>.
                  </p>
                </div>
              </div>

              {/* 5. YouTube Data API v3 Key (Server Secret or Optional Fallback) */}
              <div className="pt-5 space-y-1.5">
                {hasServerYoutubeKey ? (
                  <p className="text-xs text-slate-600">
                    YouTube Data API v3 key is configured securely on the server via{' '}
                    <span className="font-mono text-slate-800">YOUTUBE_API_KEY</span>.
                  </p>
                ) : (
                  <>
                    <label
                      htmlFor="youtube-key-fallback"
                      className="block text-sm font-medium text-slate-900"
                    >
                      YouTube Data API v3 Key (Optional Fallback)
                    </label>
                    <input
                      id="youtube-key-fallback"
                      type="password"
                      autoComplete="off"
                      value={fallbackYoutubeKey}
                      onChange={(e) => setFallbackYoutubeKey(e.target.value)}
                      disabled={isBusy}
                      placeholder="AIza..."
                      className="w-full px-3 py-2 text-sm font-mono bg-white border border-slate-300 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-900 transition-colors disabled:bg-slate-50 disabled:text-slate-500"
                    />
                    <p className="text-xs text-slate-500">
                      Set <span className="font-mono text-slate-700">YOUTUBE_API_KEY</span> in Secrets for server-managed runs, or enter a session-only fallback key here (kept in memory only).
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Form Action Footer */}
            <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center gap-3">
              {runState === 'running' || runState === 'saving' ? (
                <button
                  type="button"
                  onClick={handleStopRun}
                  disabled={isStopping || runState === 'saving'}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-60"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {runState === 'saving'
                      ? 'Saving Sheet...'
                      : isStopping
                        ? activeRunEnableDriveOutput
                          ? 'Stopping & Saving...'
                          : 'Stopping...'
                        : activeRunEnableDriveOutput
                          ? 'Stop & Save Collected'
                          : 'Stop Discovery'}
                  </span>
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleVerifyOnly}
                    disabled={isBusy || !requiresWorkspaceAuth || needsAuth}
                    title={
                      !requiresWorkspaceAuth
                        ? 'Both Google Sheets Deduplication and Google Drive Output are OFF.'
                        : needsAuth
                          ? 'Sign in with Google to verify Workspace links.'
                          : undefined
                    }
                    className="px-4 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-slate-900 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    Verify Links
                  </button>
                  <button
                    type="submit"
                    disabled={isBusy || Boolean(pendingStartConfirm)}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {runState === 'validating' ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Validating Links...</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Start Discovery Run</span>
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </form>

          {/* Right Column: Live Progress, Alerts & Results Table */}
          <div className="space-y-6 min-w-0">
            {/* Auth Prompt Banner (only shown when Google Workspace features are enabled and user is signed out) */}
            {needsAuth && requiresWorkspaceAuth && (
              <div className="bg-white border border-slate-200 rounded-lg px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900">
                    Connect Google Workspace to Begin
                  </h2>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Sign in with Google to use{' '}
                    {enableSheetsDedupe && enableDriveOutput
                      ? 'Master Sheet deduplication and Google Drive output'
                      : enableSheetsDedupe
                        ? 'Master Sheet deduplication'
                        : 'Google Drive output'}
                    , or toggle both OFF to run with YouTube Data API v3 only.
                  </p>
                </div>
                <GoogleSignInButton
                  onClick={handleSignIn}
                  disabled={isLoggingIn}
                  label={isLoggingIn ? 'Signing in...' : 'Sign in with Google'}
                />
              </div>
            )}

            {/* Visible Red Error Alert Box — Always Directly Above the Progress Bar */}
            {errorAlert && (
              <div
                role="alert"
                aria-live="assertive"
                className="bg-red-50 border border-red-300 rounded-lg px-5 py-4 text-red-950 flex items-start justify-between gap-4"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <AlertCircle className="w-5 h-5 text-red-600 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-red-900">
                      {errorAlert.title}
                    </p>
                    <p className="text-xs text-red-800 mt-1 leading-relaxed break-words font-mono">
                      {errorAlert.message}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setErrorAlert(null)}
                  aria-label="Dismiss error alert"
                  className="p-1 text-red-600 hover:text-red-900 rounded-md transition-colors shrink-0 focus-visible:outline-2 focus-visible:outline-red-700"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Live Progress & Metrics Strip */}
            <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {runState === 'running' && (
                      <span
                        className="w-2 h-2 rounded-full bg-red-600 animate-pulse shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span className="text-sm font-semibold text-slate-900 truncate">
                      {runState === 'running' && statusDetail
                        ? statusDetail
                        : runState === 'running' && progress.activeKeyword
                          ? `Active keyword: "${progress.activeKeyword}"`
                          : runState === 'saving'
                            ? 'Creating standalone Google Sheet...'
                            : runState === 'validating'
                              ? 'Validating Google Sheet and Drive folder...'
                              : runState === 'completed'
                                ? lastStopReason === 'target_reached'
                                  ? 'Discovery complete'
                                  : 'Discovery finished (partial batch)'
                                : 'Ready to run'}
                    </span>
                    {runState === 'running' && !statusDetail && progress.totalKeywords > 0 && (
                      <span className="text-xs font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        Keyword {progress.activeKeywordIndex} of {progress.totalKeywords}
                        {progress.currentPage > 0 ? ` · Page ${progress.currentPage}` : ''}
                      </span>
                    )}
                  </div>

                  <div className="text-xs font-mono tabular-nums text-slate-700 whitespace-nowrap shrink-0">
                    <span className="font-semibold text-slate-950">
                      {progress.qualifiedCount.toLocaleString()}
                    </span>{' '}
                    / {progress.targetCount.toLocaleString()} qualified ({progressPercent}%)
                  </div>
                </div>

                {/* Progress Bar */}
                <div
                  className="w-full h-2 bg-slate-100 rounded-full overflow-hidden"
                  role="progressbar"
                  aria-valuenow={progress.qualifiedCount}
                  aria-valuemin={0}
                  aria-valuemax={progress.targetCount}
                >
                  <div
                    className={`h-full transition-transform duration-200 ease-out origin-left ${
                      lastStopReason === 'quota_exceeded'
                        ? 'bg-amber-600'
                        : runState === 'completed' && lastStopReason === 'target_reached'
                          ? 'bg-emerald-600'
                          : 'bg-slate-900'
                    }`}
                    style={{
                      transform: `scaleX(${progressPercent / 100})`,
                    }}
                  />
                </div>
              </div>

              {/* 4-Column Tabular Metrics Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
                <div className="px-6 py-4">
                  <p className="text-xs text-slate-500">Qualified Leads</p>
                  <p className="text-xl font-semibold font-mono tabular-nums text-slate-950 mt-1">
                    {progress.qualifiedCount.toLocaleString()}
                    <span className="text-xs font-normal text-slate-400">
                      {' '}
                      / {progress.targetCount.toLocaleString()}
                    </span>
                  </p>
                </div>

                <div className="px-6 py-4">
                  <p className="text-xs text-slate-500">Channels Inspected</p>
                  <p className="text-xl font-semibold font-mono tabular-nums text-slate-950 mt-1">
                    {progress.channelsInspected.toLocaleString()}
                  </p>
                </div>

                <div className="px-6 py-4">
                  <p className="text-xs text-slate-500">Duplicates Skipped</p>
                  {(() => {
                    const displayDedupeOn =
                      runState === 'running' || runState === 'saving' || runState === 'completed'
                        ? activeRunEnableSheetsDedupe
                        : enableSheetsDedupe;
                    if (!displayDedupeOn) {
                      return (
                        <>
                          <p className="text-xl font-semibold font-mono tabular-nums text-slate-950 mt-1">
                            0
                          </p>
                          <p className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                            (Deduplication OFF)
                          </p>
                        </>
                      );
                    }
                    return (
                      <>
                        <p className="text-xl font-semibold font-mono tabular-nums text-slate-950 mt-1">
                          {progress.duplicatesSkipped.toLocaleString()}
                        </p>
                        {progress.existingDatabaseCount > 0 && (
                          <p className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                            vs {progress.existingDatabaseCount.toLocaleString()} in DB
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>

                <div className="px-6 py-4">
                  <p className="text-xs text-slate-500">Disqualified Skipped</p>
                  <p className="text-xl font-semibold font-mono tabular-nums text-slate-950 mt-1">
                    {progress.disqualifiedSkipped.toLocaleString()}
                  </p>
                  <p className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                    {progress.disqualifiedBreakdown.subscribers} sub ·{' '}
                    {progress.disqualifiedBreakdown.country} geo ·{' '}
                    {(() => {
                      const displayDays =
                        runState === 'running' || runState === 'saving' || runState === 'completed'
                          ? activeRunRecencyDays
                          : parsedRecencyDays.value;
                      return displayDays !== null
                        ? `${progress.disqualifiedBreakdown.activity} days (≤${displayDays}d)`
                        : `${progress.disqualifiedBreakdown.activity} days (Any)`;
                    })()}
                  </p>
                </div>
              </div>
            </section>

            {/* Compact YouTube API Quota & Reset Tracker */}
            <QuotaCard quota={quotaSnapshot} onResetRollover={() => refreshServerConfig(false)} />

            {/* Output Sheet / Status Banner */}
            {banner && (
              <div
                role="status"
                className={`border rounded-lg px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                  banner.tone === 'warning'
                    ? 'bg-amber-50/70 border-amber-200 text-amber-950'
                    : banner.tone === 'success'
                      ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                      : 'bg-white border-slate-200 text-slate-900'
                }`}
              >
                <div className="flex items-start gap-3 min-w-0">
                  {banner.tone === 'warning' ? (
                    <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  ) : banner.tone === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                  ) : (
                    <FolderCheck className="w-4 h-4 text-slate-700 mt-0.5 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{banner.title}</p>
                    <p className="text-xs opacity-90 mt-0.5 leading-relaxed">
                      {banner.message}
                    </p>
                  </div>
                </div>

                {savedSheet && (
                  <a
                    href={savedSheet.webViewLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                  >
                    <span>Open Google Sheet</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            )}

            {/* Results Preview Table */}
            <ResultsTable
              leads={qualifiedLeads}
              isRunning={runState === 'running' || runState === 'saving'}
              driveOutputEnabled={enableDriveOutput}
              canSaveToDrive={
                enableDriveOutput && !needsAuth && outputFolderInput.trim().length > 0
              }
              isSavingSheet={isSavingManualSheet}
              onDownloadCsv={() => downloadLeadsCsv(qualifiedLeads)}
              onRequestSaveSheet={() => setShowManualSaveConfirm(true)}
            />
          </div>
        </div>

        {/* Active Pipeline Qualification Rules Reference */}
        <section
          id="qualification-rules"
          className="bg-white border border-slate-200 rounded-lg overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900 tracking-tight">
              Active Qualification &amp; Storage Rules
            </h2>
            <p className="text-xs text-slate-500 font-mono tabular-nums">
              Dedupe: {enableSheetsDedupe ? 'ON' : 'OFF'}
              <span aria-hidden="true" className="mx-1.5">
                ·
              </span>
              Drive Output: {enableDriveOutput ? 'ON' : 'OFF'}
              <span aria-hidden="true" className="mx-1.5">
                ·
              </span>
              Subscribers: {subscriberRangeSummary}
              <span aria-hidden="true" className="mx-1.5">
                ·
              </span>
              Countries: {countryFilterSummary}
              <span aria-hidden="true" className="mx-1.5">
                ·
              </span>
              Upload Recency: {recencySummary}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-slate-200 text-xs">
            <div className="p-6 space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-900">
                01. Sequential Discovery
              </h3>
              <p className="text-slate-600 leading-relaxed">
                Queries keywords strictly in entered order via video search (50 results per page), advancing automatically when pages end and tracking unique channel IDs once per run.
              </p>
            </div>

            <div className="p-6 space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-900">
                02. Google Sheets Deduplication ({enableSheetsDedupe ? 'ON' : 'OFF'})
              </h3>
              <p className="text-slate-600 leading-relaxed">
                {enableSheetsDedupe ? (
                  <>
                    Enabled — loads tab{' '}
                    <span className="font-medium text-slate-900">
                      {tabNameInput.trim() || '(not set)'}
                    </span>{' '}
                    in one request before searching and skips exact case-sensitive, emoji-preserving channel name matches before spending channel metadata quota.
                  </>
                ) : (
                  <>
                    Disabled — Master Sheet deduplication is skipped for this run and Duplicates Skipped remains{' '}
                    <span className="font-medium text-slate-900">0 (Deduplication OFF)</span>.
                  </>
                )}
              </p>
            </div>

            <div className="p-6 space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-900">
                03. Ordered Qualification
              </h3>
              <p className="text-slate-600 leading-relaxed">
                Always skips hidden subscriber counts; subscriber range:{' '}
                <span className="font-medium text-slate-900">{subscriberRangeSummary}</span>.
                Country filter:{' '}
                <span className="font-medium text-slate-900">{countryFilterSummary}</span>.
                Long-form upload recency:{' '}
                <span className="font-medium text-slate-900">
                  {parsedRecencyDays.value === null
                    ? 'Any (no recency restriction)'
                    : `At least one non-Shorts video within ${parsedRecencyDays.value.toLocaleString()} ${parsedRecencyDays.value === 1 ? 'day' : 'days'}`}
                </span>
                .
              </p>
            </div>

            <div className="p-6 space-y-1.5">
              <h3 className="text-sm font-semibold text-slate-900">
                04. Google Drive Output ({enableDriveOutput ? 'ON' : 'OFF'})
              </h3>
              <p className="text-slate-600 leading-relaxed">
                {enableDriveOutput ? (
                  <>
                    Enabled — creates a brand-new standalone Google Sheet in your target Drive folder with RAW plain-text columns (Channel Name and Channel URL), never modifying existing spreadsheets, with Download CSV always available.
                  </>
                ) : (
                  <>
                    Disabled — skips automatic Google Sheet creation and disables Save New Sheet.{' '}
                    <span className="font-medium text-slate-900">Download CSV</span> is the sole active export option.
                  </>
                )}
              </p>
            </div>
          </div>
        </section>
      </main>

      {/* Pre-Run Confirmation Modal */}
      <ConfirmActionModal
        open={Boolean(pendingStartConfirm)}
        title={
          enableDriveOutput
            ? 'Confirm Discovery Run & New Google Sheet'
            : 'Confirm Discovery Run'
        }
        description={
          enableDriveOutput
            ? enableSheetsDedupe
              ? 'Your Master Database sheet and target Drive folder have been verified. When this run finishes (or stops early), a brand-new standalone Google Sheet will be created inside the target folder. Existing sheets will never be modified.'
              : 'Your target Drive folder has been verified and Google Sheets Deduplication is OFF. When this run finishes (or stops early), a brand-new standalone Google Sheet will be created inside the target folder.'
            : enableSheetsDedupe
              ? 'Your Master Database sheet has been verified and Google Drive Output is OFF. No Google Sheet will be created when this run finishes — use Download CSV to export your leads.'
              : 'Both Google Sheets Deduplication and Google Drive Output are OFF. Discovery will run using YouTube Data API v3 only, and you can export collected leads using Download CSV.'
        }
        details={startConfirmDetails}
        confirmLabel="Confirm & Start Run"
        isBusy={isBusy}
        onConfirm={executeConfirmedRun}
        onCancel={() => setPendingStartConfirm(null)}
      />

      {/* Manual / Retry Standalone Sheet Save Confirmation Modal */}
      <ConfirmActionModal
        open={showManualSaveConfirm}
        title="Create New Standalone Google Sheet?"
        description="This will create a brand-new Google Sheet in your target Drive folder containing only the Channel Name and Channel URL columns formatted as RAW plain text."
        details={manualSaveDetails}
        confirmLabel="Create Google Sheet"
        isBusy={isSavingManualSheet}
        onConfirm={handleManualSaveSheet}
        onCancel={() => setShowManualSaveConfirm(false)}
      />
    </div>
  );
}
