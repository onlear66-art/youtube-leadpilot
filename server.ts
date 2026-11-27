import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CountryFilterMode, RunStreamEvent, StartRunPayload } from './src/types/leadpilot.ts';
import { executeDiscoveryPipeline } from './server/pipeline.ts';
import { getYouTubeQuotaSnapshot } from './server/quota.ts';
import {
  createStandaloneLeadsSheet,
  extractDriveFolderId,
  validateAndLoadWorkspace,
  WorkspaceApiError,
} from './server/workspace.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 3000;

interface ActiveRunRecord {
  ownerTokenHash: string | null;
  stopTokenHash: string;
  stopped: boolean;
}

const activeRuns = new Map<string, ActiveRunRecord>();

function extractBearerToken(req: express.Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  return token.length > 10 ? token : null;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function resolveYoutubeApiKey(req: express.Request): string | null {
  const serverKey = process.env.YOUTUBE_API_KEY?.trim();
  if (serverKey && serverKey !== 'MY_YOUTUBE_API_KEY') {
    return serverKey;
  }
  const headerKey = req.headers['x-youtube-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim().length > 10) {
    return headerKey.trim();
  }
  return null;
}

function sanitizeKeywords(rawKeywords: unknown): string[] {
  if (!Array.isArray(rawKeywords)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const item of rawKeywords) {
    if (typeof item !== 'string') continue;
    const kw = item.trim();
    if (!kw || kw.length > 200) continue;
    if (!seen.has(kw)) {
      seen.add(kw);
      cleaned.push(kw);
    }
    if (cleaned.length >= 100) break;
  }
  return cleaned;
}

function sanitizeCountryCodes(rawCodes: unknown): string[] {
  if (!Array.isArray(rawCodes)) return [];
  const codes: string[] = [];
  for (const item of rawCodes) {
    if (typeof item !== 'string') continue;
    const code = item.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && !codes.includes(code)) {
      codes.push(code);
    }
  }
  return codes;
}

function parseOptionalInteger(
  raw: unknown,
  minValue: number,
  maxValue: number,
  fieldLabel: string
): { value: number | null; error?: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { value: null };
  }
  const num = Number(raw);
  if (!Number.isInteger(num) || num < minValue || num > maxValue) {
    return {
      value: null,
      error: `${fieldLabel} must be a whole number${minValue >= 1 ? ` of at least ${minValue}` : ' (0 or greater)'}, or left blank.`,
    };
  }
  return { value: num };
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // Public server capability status & Pacific-day YouTube quota tracker (never exposes secrets)
  app.get('/api/config', (_req, res) => {
    const serverKey = process.env.YOUTUBE_API_KEY?.trim();
    const hasServerYoutubeKey = Boolean(serverKey && serverKey !== 'MY_YOUTUBE_API_KEY');
    res.json({
      hasServerYoutubeKey,
      quota: getYouTubeQuotaSnapshot(0, 0),
    });
  });

  // Pre-flight validation of enabled Google Workspace links (Master Sheet and/or Output Drive Folder)
  app.post('/api/validate-workspace', async (req, res) => {
    const accessToken = extractBearerToken(req);
    if (!accessToken) {
      res.status(401).json({ error: 'Please sign in with Google to validate your Sheet and Drive folder.' });
      return;
    }

    const {
      enableSheetsDedupe = true,
      enableDriveOutput = true,
      masterSheetInput,
      tabName,
      outputFolderInput,
    } = req.body as {
      enableSheetsDedupe?: boolean;
      enableDriveOutput?: boolean;
      masterSheetInput?: string;
      tabName?: string;
      outputFolderInput?: string;
    };

    const sheetsEnabled = enableSheetsDedupe !== false;
    const driveEnabled = enableDriveOutput !== false;

    if (!sheetsEnabled && !driveEnabled) {
      res.status(400).json({
        error: 'Enable Google Sheets Deduplication or Google Drive Output before verifying Workspace links.',
      });
      return;
    }

    try {
      const { validation } = await validateAndLoadWorkspace({
        accessToken,
        enableSheetsDedupe: sheetsEnabled,
        enableDriveOutput: driveEnabled,
        masterSheetInput: String(masterSheetInput || ''),
        tabName: String(tabName || ''),
        outputFolderInput: String(outputFolderInput || ''),
      });
      res.json({ workspace: validation });
    } catch (err: unknown) {
      if (err instanceof WorkspaceApiError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      const message = err instanceof Error ? err.message : 'Workspace validation failed.';
      res.status(500).json({ error: message });
    }
  });

  // Streamed discovery, optional exact deduplication, qualification, and optional standalone Sheet creation
  app.post('/api/runs/start', async (req, res) => {
    const body = req.body as Partial<StartRunPayload>;
    const enableSheetsDedupe = body.enableSheetsDedupe !== false;
    const enableDriveOutput = body.enableDriveOutput !== false;

    const accessToken = extractBearerToken(req);
    if ((enableSheetsDedupe || enableDriveOutput) && !accessToken) {
      res.status(401).json({
        error:
          'Google Workspace sign-in is required when Google Sheets Deduplication or Google Drive Output is enabled.',
      });
      return;
    }

    const youtubeApiKey = resolveYoutubeApiKey(req);
    if (!youtubeApiKey) {
      res.status(400).json({
        error:
          'YouTube Data API v3 key is not configured. Add YOUTUBE_API_KEY in Secrets or enter a fallback key in the configuration panel.',
      });
      return;
    }

    const keywords = sanitizeKeywords(body.keywords);
    if (keywords.length === 0) {
      res.status(400).json({ error: 'Enter at least one keyword to start discovery.' });
      return;
    }

    const rawTarget = Number(body.targetCount);
    if (!Number.isInteger(rawTarget) || rawTarget < 1 || rawTarget > 5000) {
      res.status(400).json({ error: 'Target Qualified Leads Count must be a whole number between 1 and 5,000.' });
      return;
    }
    const targetCount = rawTarget;

    const parsedMinSubs = parseOptionalInteger(
      body.minSubscribers,
      0,
      1_000_000_000,
      'Min Subscribers'
    );
    if (parsedMinSubs.error) {
      res.status(400).json({ error: parsedMinSubs.error });
      return;
    }

    const parsedMaxSubs = parseOptionalInteger(
      body.maxSubscribers,
      0,
      1_000_000_000,
      'Max Subscribers'
    );
    if (parsedMaxSubs.error) {
      res.status(400).json({ error: parsedMaxSubs.error });
      return;
    }

    if (
      parsedMinSubs.value !== null &&
      parsedMaxSubs.value !== null &&
      parsedMinSubs.value > parsedMaxSubs.value
    ) {
      res.status(400).json({
        error: 'Min Subscribers cannot be greater than Max Subscribers.',
      });
      return;
    }

    const parsedRecencyDays = parseOptionalInteger(
      body.recencyDays,
      1,
      36_500,
      'Last Long-Form Upload (Days)'
    );
    if (parsedRecencyDays.error) {
      res.status(400).json({ error: parsedRecencyDays.error });
      return;
    }

    const rawCountryMode: unknown = body.countryFilterMode;
    let countryFilterMode: CountryFilterMode = 'exclude';
    if (rawCountryMode !== undefined && rawCountryMode !== null && rawCountryMode !== '') {
      if (rawCountryMode === 'exclude' || rawCountryMode === 'include') {
        countryFilterMode = rawCountryMode;
      } else {
        res.status(400).json({
          error: 'Country Filter Mode must be either "exclude" or "include".',
        });
        return;
      }
    }

    const countryCodes = sanitizeCountryCodes(body.countryCodes);
    const includeMissingCountry = body.includeMissingCountry !== false;
    const masterSheetInput = String(body.masterSheetInput || '').trim();
    const tabName = String(body.tabName || '').trim();
    const outputFolderInput = String(body.outputFolderInput || '').trim();
    const tzOffsetMinutes = Number.isFinite(Number(body.tzOffsetMinutes))
      ? Math.trunc(Number(body.tzOffsetMinutes))
      : 0;

    if (enableSheetsDedupe) {
      if (!masterSheetInput) {
        res.status(400).json({
          error: 'Master Database Google Sheet URL or ID is required when Google Sheets Deduplication is ON.',
        });
        return;
      }
      if (!tabName) {
        res.status(400).json({
          error: 'Deduplication Tab Name is required when Google Sheets Deduplication is ON.',
        });
        return;
      }
    }

    if (enableDriveOutput && !outputFolderInput) {
      res.status(400).json({
        error: 'Output Google Drive Folder URL or ID is required when Google Drive Output is ON.',
      });
      return;
    }

    // Configure NDJSON streaming response (disable reverse-proxy buffering)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const runId = crypto.randomUUID();
    const stopToken = crypto.randomBytes(16).toString('hex');
    const record: ActiveRunRecord = {
      ownerTokenHash: accessToken ? hashToken(accessToken) : null,
      stopTokenHash: hashToken(stopToken),
      stopped: false,
    };
    activeRuns.set(runId, record);

    // IMPORTANT: Listen to `res` close (NOT `req` close). In Node 18+, `req` emits
    // 'close' as soon as express.json() finishes reading the POST body, which would
    // prematurely abort the pipeline before any YouTube requests execute.
    let connectionClosed = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        connectionClosed = true;
        record.stopped = true;
      }
    });

    const emit = (event: RunStreamEvent) => {
      if (connectionClosed || res.writableEnded) return;
      try {
        res.write(`${JSON.stringify(event)}\n`);
      } catch {
        connectionClosed = true;
        record.stopped = true;
      }
    };

    try {
      await executeDiscoveryPipeline({
        runId,
        stopToken,
        accessToken,
        youtubeApiKey,
        keywords,
        targetCount,
        minSubscribers: parsedMinSubs.value,
        maxSubscribers: parsedMaxSubs.value,
        recencyDays: parsedRecencyDays.value,
        countryFilterMode,
        countryCodes,
        includeMissingCountry,
        enableSheetsDedupe,
        enableDriveOutput,
        masterSheetInput,
        tabName,
        outputFolderInput,
        tzOffsetMinutes,
        shouldStop: () => record.stopped,
        emit,
      });
    } catch (err: unknown) {
      const code = err instanceof WorkspaceApiError ? err.code : 'PIPELINE_ERROR';
      const message =
        err instanceof Error ? err.message : 'An unexpected error occurred while starting the discovery run.';
      emit({ type: 'error', message, code });
    } finally {
      activeRuns.delete(runId);
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  // Request graceful stop on an active run so partial results are still finalized
  app.post('/api/runs/:runId/stop', (req, res) => {
    const { runId } = req.params;
    const record = activeRuns.get(runId);
    if (!record) {
      res.status(404).json({ error: 'No active run found with that ID.' });
      return;
    }

    const accessToken = extractBearerToken(req);
    const rawStopHeader = req.headers['x-run-stop-token'];
    const stopTokenHeader = typeof rawStopHeader === 'string' ? rawStopHeader.trim() : '';

    let authorized = false;

    if (stopTokenHeader) {
      const providedStopHash = Buffer.from(hashToken(stopTokenHeader), 'hex');
      const expectedStopHash = Buffer.from(record.stopTokenHash, 'hex');
      if (
        providedStopHash.length === expectedStopHash.length &&
        crypto.timingSafeEqual(providedStopHash, expectedStopHash)
      ) {
        authorized = true;
      }
    }

    if (!authorized && accessToken && record.ownerTokenHash) {
      const callerHash = Buffer.from(hashToken(accessToken), 'hex');
      const ownerHash = Buffer.from(record.ownerTokenHash, 'hex');
      if (callerHash.length === ownerHash.length && crypto.timingSafeEqual(callerHash, ownerHash)) {
        authorized = true;
      }
    }

    if (!authorized) {
      res.status(accessToken || stopTokenHeader ? 403 : 401).json({
        error: 'Not authorized to stop this run.',
      });
      return;
    }

    record.stopped = true;
    res.json({ ok: true });
  });

  // Retry / manual save of collected leads into a brand-new standalone Google Sheet in the target folder
  app.post('/api/sheets/save', async (req, res) => {
    const accessToken = extractBearerToken(req);
    if (!accessToken) {
      res.status(401).json({ error: 'Please sign in with Google to save a new Google Sheet.' });
      return;
    }

    const { outputFolderInput, leads, tzOffsetMinutes } = req.body as {
      outputFolderInput?: string;
      leads?: Array<{ channelName?: unknown; channelUrl?: unknown }>;
      tzOffsetMinutes?: number;
    };

    const folderId = extractDriveFolderId(String(outputFolderInput || ''));
    if (!folderId) {
      res.status(400).json({ error: 'Invalid Output Google Drive Folder URL or ID.' });
      return;
    }

    if (!Array.isArray(leads) || leads.length === 0) {
      res.status(400).json({ error: 'There are no qualified leads to save.' });
      return;
    }

    const sanitizedLeads = leads
      .filter(
        (item) =>
          typeof item?.channelName === 'string' &&
          typeof item?.channelUrl === 'string' &&
          item.channelUrl.startsWith('https://')
      )
      .slice(0, 5000)
      .map((item) => ({
        channelName: String(item.channelName),
        channelUrl: String(item.channelUrl),
      }));

    if (sanitizedLeads.length === 0) {
      res.status(400).json({ error: 'No valid lead rows were provided.' });
      return;
    }

    try {
      const savedSheet = await createStandaloneLeadsSheet({
        accessToken,
        targetFolderId: folderId,
        leads: sanitizedLeads,
        tzOffsetMinutes: Number.isFinite(Number(tzOffsetMinutes)) ? Math.trunc(Number(tzOffsetMinutes)) : 0,
      });
      res.json({ savedSheet });
    } catch (err: unknown) {
      if (err instanceof WorkspaceApiError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to create standalone Google Sheet.';
      res.status(500).json({ error: message });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  const distDir = path.resolve(__dirname, 'dist');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`YouTube LeadPilot server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start YouTube LeadPilot server:', err);
  process.exit(1);
});
