import type { MutableFile, Storage } from 'megajs';
import { MegaService } from './mega';
import { isTransportStream } from './stream';
import { detectScenesFromFile, saveScenes, type SceneScanResult } from './scenes';
import { saveThumbnailFrame } from './thumbnails';
import { generateStripFromFile, saveStrip } from './strips';
import type { SceneAnalysisMode } from './labeler';
import {
  saveSubtitles,
  transcribeLocalFile,
  type SubtitleJob,
  type SubtitleResult,
} from './subtitles.svelte';
import { showToast } from './toast.svelte';

export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'analyzing'
  | 'subtitling'
  | 'done'
  | 'error'
  | 'cancelled';

export interface UploadSubtitles extends SubtitleJob {
  /** Tracks are back from Scene AI and wait for the upload to finish. */
  ready: boolean;
  error?: string;
}

export interface UploadJob {
  id: string;
  name: string;
  size: number;
  uploaded: number;
  status: UploadStatus;
  error?: string;
  folderId: string;
  /** Scene-scan progress 0-100; null until the scan reports anything. */
  analysisPct: number | null;
  /** Whether subtitles can be requested for this file at all. */
  canSubtitle: boolean;
  /** Subtitle generation requested from the panel; null when not requested. */
  subtitles: UploadSubtitles | null;
}

const MAX_CONCURRENT = 3;
const AUTO_REMOVE_DONE_MS = 2500;

let _jobs = $state<UploadJob[]>([]);
let running = 0;
const queue: Array<{
  id: string;
  file: File;
  folder: MutableFile;
  sceneMode: SceneAnalysisMode;
}> = [];
const cancellers = new Map<string, () => void>();
// Local files of jobs that haven't finished uploading — subtitles requested
// mid-upload transcribe from these instead of downloading from MEGA again.
const activeFiles = new Map<string, File>();
const subtitleRuns = new Map<
  string,
  { promise: Promise<SubtitleResult>; abort: AbortController }
>();

export const uploads = {
  get jobs(): UploadJob[] {
    return _jobs;
  },
};

function findJob(id: string): UploadJob | undefined {
  // Returns the proxied entry from $state — mutations on this trigger UI updates.
  return _jobs.find((j) => j.id === id);
}

export function enqueueUpload(
  folder: MutableFile,
  file: File,
  sceneMode: SceneAnalysisMode = 'static'
): UploadJob {
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const job: UploadJob = {
    id,
    name: file.name,
    size: file.size,
    uploaded: 0,
    status: 'queued',
    folderId: folder.nodeId || '',
    analysisPct: null,
    canSubtitle: MegaService.isVideo(file.name) && !isTransportStream(file.name),
    subtitles: null,
  };
  _jobs.push(job);
  activeFiles.set(id, file);
  queue.push({ id, file, folder, sceneMode });
  drain();
  return findJob(id) ?? job;
}

export function clearFinishedUploads() {
  _jobs = _jobs.filter((j) => j.status === 'queued' || j.status === 'uploading');
}

/**
 * Transcribes (and translates, per the Scene AI settings) an upload once it
 * lands. Transcription starts right away from the local file and runs
 * alongside the MEGA upload; the tracks are saved when the upload is done.
 */
export function requestUploadSubtitles(jobId: string) {
  const job = findJob(jobId);
  const file = activeFiles.get(jobId);
  if (!job || !file || !job.canSubtitle || job.subtitles) return;
  if (job.status !== 'queued' && job.status !== 'uploading' && job.status !== 'analyzing') return;
  job.subtitles = { stage: 'upload', progress: 0, ready: false };
  const progress = job.subtitles; // the reactive proxy, not the literal
  const abort = new AbortController();
  const promise = transcribeLocalFile(file, progress, abort.signal);
  promise.then(
    () => (progress.ready = true),
    () => {} // reported once the upload is done, by finishSubtitles
  );
  subtitleRuns.set(jobId, { promise, abort });
}

function abortSubtitles(jobId: string) {
  subtitleRuns.get(jobId)?.abort.abort();
  subtitleRuns.delete(jobId);
}

export function cancelUploadSubtitles(jobId: string) {
  const job = findJob(jobId);
  // Once the upload is through, finishSubtitles owns the run and wraps up.
  if (job?.status === 'subtitling') {
    subtitleRuns.get(jobId)?.abort.abort();
    return;
  }
  abortSubtitles(jobId);
  if (job) job.subtitles = null;
}

async function finishSubtitles(
  id: string,
  run: { promise: Promise<SubtitleResult>; abort: AbortController },
  storage: Storage | undefined,
  videoId: string | undefined
) {
  let failed = false;
  try {
    const result = await run.promise;
    if (!storage || !videoId) throw new Error('uploaded file is not available');
    const sub = findJob(id)?.subtitles;
    if (sub) {
      sub.stage = 'saving';
      sub.progress = 0;
    }
    await saveSubtitles(storage, videoId, result.tracks);
    if (result.warning) showToast(result.warning, 'warning');
  } catch (err) {
    if (!run.abort.signal.aborted) {
      failed = true;
      const sub = findJob(id)?.subtitles;
      if (sub) sub.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    subtitleRuns.delete(id);
    const job = findJob(id);
    if (job) {
      job.status = 'done';
      // A failure stays listed so the error can be read.
      if (!failed) scheduleAutoRemove(id);
    }
  }
}

export function cancelUpload(jobId: string) {
  const job = findJob(jobId);
  if (!job) return;
  if (job.status === 'subtitling') {
    cancelUploadSubtitles(jobId);
    return;
  }
  if (job.status === 'uploading' || job.status === 'queued' || job.status === 'analyzing') {
    // During 'analyzing' the upload itself already succeeded; cancelling
    // just skips the scene scan and the job still completes as 'done'.
    if (job.status !== 'analyzing') {
      job.status = 'cancelled';
      abortSubtitles(jobId);
    }
    cancellers.get(jobId)?.();
    cancellers.delete(jobId);
  }
}

function scheduleAutoRemove(id: string) {
  setTimeout(() => {
    const j = findJob(id);
    if (!j) return;
    if (j.status === 'done' || j.status === 'cancelled') {
      _jobs = _jobs.filter((x) => x.id !== id);
    }
  }, AUTO_REMOVE_DONE_MS);
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const job = findJob(next.id);
    if (!job || job.status === 'cancelled') {
      activeFiles.delete(next.id);
      continue;
    }
    running++;
    run(next.id, next.file, next.folder, next.sceneMode).finally(() => {
      running--;
      cancellers.delete(next.id);
      activeFiles.delete(next.id);
      drain();
    });
  }
}

async function run(
  id: string,
  file: File,
  folder: MutableFile,
  sceneMode: SceneAnalysisMode = 'static'
) {
  const job = findJob(id);
  if (!job) return;
  job.status = 'uploading';
  let uploadStream: any;
  // Scene detection reads the File independently of the upload stream, so it
  // runs in parallel with the (network-bound) upload and is usually done
  // before the last byte is sent.
  let analysisAbort: AbortController | null = null;
  let analysis: Promise<SceneScanResult | null> | null = null;
  if (sceneMode !== 'skip' && MegaService.isVideo(file.name) && !isTransportStream(file.name)) {
    const abort = new AbortController();
    analysisAbort = abort;
    analysis = detectScenesFromFile(file, {
      signal: abort.signal,
      withLabels: sceneMode === 'labeled',
      onProgress: (processed, duration) => {
        const j = findJob(id);
        if (j && duration > 0) {
          j.analysisPct = Math.min(100, Math.round((processed / duration) * 100));
        }
      },
    }).catch((err) => {
      if (!abort.signal.aborted) console.warn('Scene analysis failed for', file.name, err);
      return null;
    });
  }
  try {
    uploadStream = (folder as any).upload({ name: file.name, size: file.size });
    cancellers.set(id, () => {
      try {
        uploadStream?.destroy?.();
      } catch (_) {}
      analysisAbort?.abort();
    });

    const reader = file.stream().getReader();
    while (true) {
      const current = findJob(id);
      if (!current || current.status === 'cancelled') {
        try {
          uploadStream.destroy();
        } catch (_) {}
        try {
          reader.cancel();
        } catch (_) {}
        analysisAbort?.abort();
        abortSubtitles(id);
        scheduleAutoRemove(id);
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      const ok = uploadStream.write(value);
      current.uploaded += value.byteLength;
      if (!ok) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            uploadStream.off?.('drain', onDrain);
            uploadStream.off?.('error', onError);
            resolve();
          };
          const onError = (err: Error) => {
            uploadStream.off?.('drain', onDrain);
            uploadStream.off?.('error', onError);
            reject(err);
          };
          uploadStream.on('drain', onDrain);
          uploadStream.on('error', onError);
        });
      }
    }
    uploadStream.end();
    const uploadedNode = (await uploadStream.complete) as MutableFile | undefined;
    const storage = (folder as unknown as { storage?: Storage }).storage;
    const videoId = (uploadedNode as unknown as { nodeId?: string } | undefined)?.nodeId;

    if (analysis) {
      const current = findJob(id);
      if (current && current.status === 'uploading') {
        current.status = 'analyzing';
        current.uploaded = current.size;
        const scan = await analysis;
        if (scan && storage && videoId) {
          try {
            await saveScenes(storage, videoId, scan.data, uploadedNode);
          } catch (err) {
            console.warn('Failed to save scene data for', file.name, err);
          }
          if (scan.thumb) {
            try {
              await saveThumbnailFrame(storage, videoId, scan.thumb.blob);
            } catch (err) {
              console.warn('Thumbnail save failed for', file.name, err);
            }
          }
          // Animated thumbnail strip from the local file while we still
          // have it — a handful of local seeks, then one small upload.
          try {
            const cap = await generateStripFromFile(file, scan.data);
            if (cap) await saveStrip(storage, videoId, cap);
          } catch (err) {
            console.warn('Strip generation failed for', file.name, err);
          }
        }
      } else {
        analysisAbort?.abort();
      }
    }

    // Checked after the scan so a request made while it ran isn't missed.
    const subtitleRun = subtitleRuns.get(id);
    if (subtitleRun) {
      const current = findJob(id);
      if (current) {
        current.status = 'subtitling';
        current.uploaded = current.size;
      }
      // Detached: transcription can take minutes and shouldn't hold one of
      // the upload slots.
      void finishSubtitles(id, subtitleRun, storage, videoId);
      return;
    }

    const done = findJob(id);
    if (done) {
      done.status = 'done';
      done.uploaded = done.size;
      scheduleAutoRemove(id);
    }
  } catch (err) {
    analysisAbort?.abort();
    abortSubtitles(id);
    const failed = findJob(id);
    if (!failed) return;
    if (failed.status === 'cancelled') {
      scheduleAutoRemove(id);
      return;
    }
    failed.status = 'error';
    failed.error = err instanceof Error ? err.message : String(err);
  }
}
