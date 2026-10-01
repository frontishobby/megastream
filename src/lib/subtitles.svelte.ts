// On-demand subtitles through the local Scene AI server (labeler/server.py).
// The browser streams the decrypted video into a server job, the server
// transcribes (and optionally translates) it, and the resulting WebVTT
// tracks are stored as .megastream/<nodeId>.sub.<lang>.vtt sidecars.

import type { MutableFile, Storage } from 'megajs';
import { labelerUrl } from './labeler';
import { createStreamUrl } from './stream';
import { ensureThumbFolder, findThumbFolder, uploadBytes } from './thumbnails';

export const SUBTITLE_LANGS = {
  en: 'English',
  ko: 'Korean',
  zh: 'Chinese',
  ja: 'Japanese',
} as const;
export type SubtitleLang = keyof typeof SUBTITLE_LANGS;

export function subtitleLangLabel(lang: string): string {
  return (SUBTITLE_LANGS as Record<string, string>)[lang] ?? lang;
}

// --- Settings (per browser) ---------------------------------------------

export interface SubtitleSettings {
  /** Spoken language, or 'auto' to let whisper detect it. */
  source: SubtitleLang | 'auto';
  /** Extra translated track when it differs from the spoken language. */
  target: SubtitleLang | 'none';
}

const SETTINGS_KEY = 'megastream.subtitleSettings';
const DEFAULT_SETTINGS: SubtitleSettings = { source: 'auto', target: 'none' };

export function loadSubtitleSettings(): SubtitleSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const isLang = (v: unknown): v is SubtitleLang =>
      typeof v === 'string' && v in SUBTITLE_LANGS;
    return {
      source: isLang(raw.source) ? raw.source : DEFAULT_SETTINGS.source,
      target: isLang(raw.target) ? raw.target : DEFAULT_SETTINGS.target,
    };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSubtitleSettings(settings: SubtitleSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {}
}

// --- Sidecar storage ------------------------------------------------------

export interface StoredSubtitle {
  lang: string;
  vtt: string;
}

/** Translated tracks carry this NOTE (see _to_vtt in labeler/server.py). */
function isTranslation(vtt: string): boolean {
  return /^NOTE translated from /m.test(vtt);
}

const SUB_INFIX = '.sub.';
const SUB_EXT = '.vtt';

function subtitleFileName(videoId: string, lang: string): string {
  return `${videoId}${SUB_INFIX}${lang}${SUB_EXT}`;
}

function subtitleLangOf(videoId: string, name: string): string | null {
  const prefix = `${videoId}${SUB_INFIX}`;
  if (!name.startsWith(prefix) || !name.endsWith(SUB_EXT)) return null;
  return name.slice(prefix.length, -SUB_EXT.length) || null;
}

/** Fired with the video id whenever new subtitles are saved. */
export const subtitleEvents = new EventTarget();

const cache = new Map<string, StoredSubtitle[]>();

/** Loads previously generated subtitles. Never generates anything. */
export async function getStoredSubtitles(
  videoId: string,
  storage: Storage | undefined
): Promise<StoredSubtitle[]> {
  const hit = cache.get(videoId);
  if (hit) return hit;
  if (!storage?.root) return [];
  const folder = findThumbFolder(storage);
  if (!folder) return [];
  const out: StoredSubtitle[] = [];
  for (const file of (folder.children || []) as MutableFile[]) {
    const lang = !file.directory && subtitleLangOf(videoId, file.name || '');
    if (!lang) continue;
    try {
      const buf = await file.downloadBuffer({});
      out.push({ lang, vtt: new TextDecoder().decode(buf as unknown as Uint8Array) });
    } catch (err) {
      console.warn('Subtitle load failed', file.name, err);
    }
  }
  cache.set(videoId, out);
  return out;
}

export async function saveSubtitles(
  storage: Storage,
  videoId: string,
  tracks: StoredSubtitle[]
): Promise<void> {
  const folder = await ensureThumbFolder(storage);
  for (const track of tracks) {
    const name = subtitleFileName(videoId, track.lang);
    // MEGA allows duplicate names; replace instead of piling up copies.
    const stale = ((folder.children || []) as MutableFile[]).filter(
      (c) => !c.directory && c.name === name
    );
    for (const f of stale) {
      try {
        await f.delete(true);
      } catch (err) {
        console.warn('Failed to remove stale subtitles', err);
      }
    }
    await uploadBytes(folder, name, new TextEncoder().encode(track.vtt));
  }
  // Tracks not regenerated this time (e.g. an earlier translation) stay.
  const kept = (cache.get(videoId) ?? []).filter(
    (old) => !tracks.some((t) => t.lang === old.lang)
  );
  cache.set(videoId, [...tracks, ...kept]);
  subtitleEvents.dispatchEvent(new CustomEvent('subtitles', { detail: videoId }));
}

// --- Generation -------------------------------------------------------------

export type SubtitleStage =
  | 'upload'
  | 'queued'
  | 'loading'
  | 'transcribing'
  | 'translating'
  | 'saving';

export interface SubtitleJob {
  stage: SubtitleStage;
  /** 0-1 within the current stage. */
  progress: number;
}

const STAGE_LABELS: Record<SubtitleStage, string> = {
  upload: 'Sending',
  queued: 'Queued',
  loading: 'Loading model',
  transcribing: 'Transcribing',
  translating: 'Translating',
  saving: 'Saving',
};

/** e.g. "Transcribing 42%", or "Queued…" for stages without progress. */
export function subtitleStageLabel(job: SubtitleJob): string {
  const label = STAGE_LABELS[job.stage];
  return job.stage === 'queued' || job.stage === 'loading' || job.stage === 'saving'
    ? `${label}…`
    : `${label} ${Math.round(job.progress * 100)}%`;
}

/** Running jobs keyed by video id, so a view can pick up a job it didn't start. */
export const subtitleJobs = $state<Record<string, SubtitleJob>>({});

interface MegaFileLike {
  size?: number;
  name?: string | null;
  download(opts: { start: number; end: number }): any;
}

interface ServerTrack {
  lang: string;
  translated: boolean;
  vtt: string;
}

interface ServerStatus {
  state: 'receiving' | 'queued' | 'loading' | 'transcribing' | 'translating' | 'done' | 'error';
  progress: number;
  error: string | null;
  warning: string | null;
  tracks?: ServerTrack[];
}

const RETRIES = 3;
const POLL_MS = 2000;
// A restarted or crashed server loses its jobs; give up after this many
// consecutive failed polls (~30s) instead of spinning forever.
const MAX_POLL_FAILURES = 15;
const FILE_CHUNK = 64 * 1024 * 1024;

async function withRetries<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      console.warn(`${what} failed (attempt ${attempt}/${RETRIES}), retrying:`, err);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function readRange(url: string, offset: number): Promise<ArrayBuffer> {
  // The service worker windows open-ended ranges into bounded 206 slices, so
  // each request yields the next tens of MB.
  const res = await fetch(url, { headers: { Range: `bytes=${offset}-` } });
  if (!res.ok) throw new Error(`stream read failed (HTTP ${res.status})`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error('stream returned no data');
  return buf;
}

async function sendChunk(base: string, jobId: string, offset: number, data: BodyInit) {
  const res = await fetch(`${base}/subtitles/jobs/${jobId}/data?offset=${offset}`, {
    method: 'PUT',
    body: data,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`Scene AI rejected video data (HTTP ${res.status})`);
}

async function pollUntilDone(
  base: string,
  jobId: string,
  job: SubtitleJob,
  signal?: AbortSignal
): Promise<ServerStatus> {
  let failures = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    signal?.throwIfAborted();
    let status: ServerStatus;
    try {
      const res = await fetch(`${base}/subtitles/jobs/${jobId}`);
      if (res.status === 404) throw new Error('Scene AI lost the job (server restarted?)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      status = await res.json();
      failures = 0;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Scene AI lost')) throw err;
      if (++failures >= MAX_POLL_FAILURES) throw new Error('Scene AI stopped responding');
      continue;
    }
    if (status.state === 'done') return status;
    if (status.state === 'error') throw new Error(status.error || 'subtitle generation failed');
    if (status.state !== 'receiving') {
      job.stage = status.state;
      job.progress = status.progress;
    }
  }
}

export interface SubtitleResult {
  tracks: StoredSubtitle[];
  warning: string | null;
}

/** Hands the video to the server: `send` uploads one chunk at `offset`. */
type Feed = (send: (offset: number, data: BodyInit) => Promise<void>) => Promise<void>;

/**
 * Creates one server job, feeds it the video (unless it's translation-only),
 * and waits for the tracks. The server job is always deleted afterwards,
 * which also cancels it when we bail out early.
 */
async function runServerJob(
  body: object,
  feed: Feed | null,
  job: SubtitleJob,
  signal?: AbortSignal
): Promise<SubtitleResult> {
  const base = labelerUrl();
  let jobId: string | null = null;
  try {
    const created = await fetch(`${base}/subtitles/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (created.status === 404) {
      throw new Error('Scene AI server is outdated — restart run.bat to update it');
    }
    if (!created.ok) throw new Error(`Scene AI refused the job (HTTP ${created.status})`);
    const id = (await created.json()).id as string;
    jobId = id;

    if (feed) {
      await feed((offset, data) => {
        signal?.throwIfAborted();
        return withRetries('Chunk upload', () => sendChunk(base, id, offset, data));
      });
      signal?.throwIfAborted();
      const started = await fetch(`${base}/subtitles/jobs/${id}/start`, { method: 'POST' });
      if (!started.ok) throw new Error(`Scene AI could not start the job (HTTP ${started.status})`);
      job.stage = 'queued';
      job.progress = 0;
    }

    const status = await pollUntilDone(base, id, job, signal);
    const tracks = (status.tracks ?? []).map((t) => ({ lang: t.lang, vtt: t.vtt }));
    if (tracks.length === 0) throw new Error('Scene AI returned no subtitles');
    return { tracks, warning: status.warning };
  } finally {
    if (jobId) fetch(`${base}/subtitles/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
  }
}

/**
 * Generates subtitles for one stored video with the current settings and
 * saves them to MEGA. When the original transcript already exists and only
 * the translation is missing, just that transcript is sent for translation;
 * otherwise the whole video is streamed to the server and transcribed.
 * `onTransferStart`/`onTransferEnd` bracket the MEGA download, if any.
 */
export async function generateSubtitles(
  storage: Storage,
  videoId: string,
  node: MegaFileLike,
  opts: { onTransferStart?: () => void; onTransferEnd?: () => void } = {}
): Promise<SubtitleResult> {
  if (subtitleJobs[videoId]) throw new Error('Subtitles are already being generated');
  const size = node.size;
  if (typeof size !== 'number' || size <= 0) throw new Error('File size is unknown');

  const settings = loadSubtitleSettings();
  const stored = await getStoredSubtitles(videoId, storage);
  const original = stored.find((t) => !isTranslation(t.vtt));
  const translateOnly =
    !!original &&
    settings.target !== 'none' &&
    settings.target !== original.lang &&
    !stored.some((t) => t.lang === settings.target);

  subtitleJobs[videoId] = { stage: translateOnly ? 'queued' : 'upload', progress: 0 };
  // Read back through the store so progress writes hit the reactive proxy.
  const job = subtitleJobs[videoId];
  try {
    const feed: Feed | null = translateOnly
      ? null
      : async (send) => {
          opts.onTransferStart?.();
          try {
            const { url, cleanup } = await createStreamUrl(node);
            try {
              let offset = 0;
              while (offset < size) {
                const at = offset;
                const chunk = await withRetries('Stream read', () => readRange(url, at));
                await send(at, chunk);
                offset += chunk.byteLength;
                job.progress = offset / size;
              }
            } finally {
              cleanup();
            }
          } finally {
            opts.onTransferEnd?.();
          }
        };
    const result = await runServerJob(
      translateOnly
        ? { source: original!.lang, target: settings.target, vtt: original!.vtt }
        : { source: settings.source, target: settings.target },
      feed,
      job
    );
    job.stage = 'saving';
    job.progress = 0;
    await saveSubtitles(storage, videoId, result.tracks);
    return result;
  } finally {
    delete subtitleJobs[videoId];
  }
}

/**
 * Transcribes (and translates, per the current settings) a local file —
 * used while uploading, so nothing has to come back down from MEGA. Doesn't
 * save; the caller stores the tracks once the upload has a node id.
 */
export function transcribeLocalFile(
  file: File,
  job: SubtitleJob,
  signal?: AbortSignal
): Promise<SubtitleResult> {
  const settings = loadSubtitleSettings();
  return runServerJob(
    { source: settings.source, target: settings.target },
    async (send) => {
      for (let offset = 0; offset < file.size; offset += FILE_CHUNK) {
        // Blob bodies stream straight from disk; the file never sits in memory.
        await send(offset, file.slice(offset, offset + FILE_CHUNK));
        job.progress = Math.min(1, (offset + FILE_CHUNK) / file.size);
      }
    },
    job,
    signal
  );
}
