import { createStreamUrl } from './stream';
import { attachTsPlayer, isTransportStream, type TsPlayerHandle } from './tsPlayer';
import { Semaphore, ensureThumbFolder, findThumbFolder, uploadBytes } from './thumbnails';
import { classifyFrame } from './labeler';
import type { Storage, MutableFile } from 'megajs';

export interface Scene {
  i: number;
  start: number;
  end: number;
  // Filled in later by the (offline) position-labelling pass; null until then.
  position: string | null;
  confidence: number | null;
}

export interface SceneData {
  v: 1;
  duration: number;
  detector: string;
  scenes: Scene[];
}

interface MegaFileLike {
  size?: number;
  name?: string | null;
  storage?: Storage;
  download(opts: { start: number; end: number; maxConnections?: number }): any;
}

// Fired with the video node id as detail whenever scene data becomes available.
export const sceneEvents = new EventTarget();

export interface SceneDetectOptions {
  /** Minimum media-time gap between analysed frames, seconds. */
  sampleInterval?: number;
  /** Cuts closer together than this are merged, seconds. */
  minSceneLen?: number;
  /** Per-block mean-abs-diff (0-255) above which a block counts as changed. */
  blockDiff?: number;
  /** Fraction of blocks that must change for a sample to be a cut candidate. */
  cutFrac?: number;
  /** Candidate must exceed neighbouring samples' fraction by this margin. */
  peakMargin?: number;
  /** Playback speed for the scan pass. */
  playbackRate?: number;
  /** After detection, classify each scene's keyframe via the local labeler. */
  withLabels?: boolean;
  signal?: AbortSignal;
  onProgress?: (processedSec: number, durationSec: number) => void;
  onLabelProgress?: (done: number, total: number) => void;
}

const DETECTOR = 'block-peak-v2';
// Tiny grayscale buffer is plenty for hard-cut detection and keeps the
// per-frame cost trivial.
const W = 64;
const H = 36;
// 8×6 grid of 8×6-pixel blocks. Motion changes some blocks; a cut changes
// nearly all of them — the changed-block fraction separates the two far
// better than a whole-frame average.
const BX = 8;
const BY = 6;
const BW = W / BX;
const BH = H / BY;

function changedBlockFraction(a: Uint8Array, b: Uint8Array, blockDiff: number): number {
  let changed = 0;
  for (let by = 0; by < BY; by++) {
    for (let bx = 0; bx < BX; bx++) {
      let sum = 0;
      const x0 = bx * BW;
      const y0 = by * BH;
      for (let y = y0; y < y0 + BH; y++) {
        const row = y * W;
        for (let x = x0; x < x0 + BW; x++) {
          const d = a[row + x] - b[row + x];
          sum += d < 0 ? -d : d;
        }
      }
      if (sum / (BW * BH) >= blockDiff) changed++;
    }
  }
  return changed / (BX * BY);
}

// A scan decodes the whole video, so cap concurrent scans.
const detectSem = new Semaphore(2);

function makeVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  return v;
}

function waitMetadata(video: HTMLVideoElement, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1) return resolve();
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('metadata timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('video load error'));
    };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

function teardownVideo(video: HTMLVideoElement) {
  try {
    video.pause();
  } catch (_) {}
  video.removeAttribute('src');
  try {
    video.load();
  } catch (_) {}
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function buildScenes(boundaries: number[], duration: number, minSceneLen: number): Scene[] {
  const starts = [0, ...boundaries.filter((b) => b > 0 && b < duration)];
  const scenes: Scene[] = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : duration;
    if (end - start <= 0) continue;
    scenes.push({ i: scenes.length, start: round2(start), end: round2(end), position: null, confidence: null });
  }
  // Fold a too-short tail into the previous scene.
  if (scenes.length >= 2) {
    const tail = scenes[scenes.length - 1];
    if (tail.end - tail.start < minSceneLen) {
      scenes[scenes.length - 2].end = tail.end;
      scenes.pop();
    }
  }
  return scenes;
}

/**
 * Plays the (muted, sped-up) video once and flags hard cuts. Each sampled
 * frame pair gets a changed-block fraction (how much of the frame changed,
 * not how strongly), and a cut must be a *peak*: a single-sample spike that
 * clearly exceeds both the preceding and following samples. Sustained high
 * fractions (whip pans, close-up motion) never form a peak, and localized
 * motion never changes enough blocks.
 */
async function runDetection(
  video: HTMLVideoElement,
  duration: number,
  opts: SceneDetectOptions
): Promise<SceneData> {
  const {
    sampleInterval = 0.2,
    minSceneLen = 1.5,
    blockDiff = 25,
    // A real cut swaps nearly the whole frame; rhythmic motion bursts peak
    // around 0.4-0.7, so demand a high fraction AND a clear margin over the
    // neighbours to keep them out.
    cutFrac = 0.72,
    peakMargin = 0.3,
    playbackRate = 4,
    signal,
    onProgress,
  } = opts;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas context unavailable');

  const boundaries: number[] = [];

  await new Promise<void>((resolve, reject) => {
    let prev: Uint8Array | null = null;
    let prevT = -Infinity;
    let lastCut = 0;
    let settled = false;

    // Peak detection over the sampled change fractions: a sample is decided
    // only once LOOKAHEAD later samples exist, so both sides of a candidate
    // spike are known.
    const LOOKBACK = 3;
    const LOOKAHEAD = 2;
    const samples: Array<{ t: number; frac: number }> = [];
    let decided = 0;

    const decide = (idx: number) => {
      const s = samples[idx];
      if (s.frac < cutFrac) return;
      let maxNeighbor = 0;
      for (let k = Math.max(0, idx - LOOKBACK); k < idx; k++) {
        if (samples[k].frac > maxNeighbor) maxNeighbor = samples[k].frac;
      }
      const hi = Math.min(samples.length - 1, idx + LOOKAHEAD);
      for (let k = idx + 1; k <= hi; k++) {
        if (samples[k].frac > maxNeighbor) maxNeighbor = samples[k].frac;
      }
      if (s.frac - maxNeighbor < peakMargin) return;
      if (s.t - lastCut < minSceneLen) return;
      boundaries.push(s.t);
      lastCut = s.t;
    };

    const drainDecisions = (flush: boolean) => {
      const limit = flush ? samples.length : samples.length - LOOKAHEAD;
      while (decided < limit) decide(decided++);
    };

    const rvfc: ((cb: (now: number, meta: { mediaTime: number }) => void) => void) | undefined = (
      video as any
    ).requestVideoFrameCallback?.bind(video);

    // rVFC/rAF stop firing in hidden tabs while the video keeps playing,
    // which would silently skip cuts — pause the scan instead.
    const onVisibility = () => {
      if (settled) return;
      if (document.hidden) {
        try {
          video.pause();
        } catch (_) {}
      } else {
        video.play().catch(() => {});
      }
    };

    // Network death leaves the playback pass waiting forever; bail out if
    // currentTime stops advancing for ~90s while the tab is visible.
    let lastWatchdogT = video.currentTime;
    let stalledChecks = 0;
    const watchdog = window.setInterval(() => {
      if (settled || document.hidden) return;
      const t = video.currentTime;
      if (t > lastWatchdogT + 0.01) {
        lastWatchdogT = t;
        stalledChecks = 0;
        return;
      }
      stalledChecks++;
      if (stalledChecks >= 6) finish(new Error('scene scan stalled (no playback progress)'));
    }, 15000);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onVisibility);
      signal?.removeEventListener('abort', onAbort);
      try {
        video.pause();
      } catch (_) {}
      if (err) {
        reject(err);
      } else {
        drainDecisions(true);
        resolve();
      }
    };
    const onEnded = () => finish();
    const onError = () =>
      finish(new Error(`video error: ${video.error?.message || video.error?.code || 'unknown'}`));
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError') as unknown as Error);

    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVisibility);
    signal?.addEventListener('abort', onAbort);

    const sample = (mediaTime: number) => {
      if (mediaTime - prevT < sampleInterval) return;
      let gray: Uint8Array;
      try {
        ctx.drawImage(video, 0, 0, W, H);
        const px = ctx.getImageData(0, 0, W, H).data;
        gray = new Uint8Array(W * H);
        for (let i = 0, p = 0; i < px.length; i += 4, p++) {
          gray[p] = (px[i] * 3 + px[i + 1] * 4 + px[i + 2]) >> 3;
        }
      } catch (_) {
        return; // frame not decodable yet
      }
      if (prev) {
        samples.push({ t: mediaTime, frac: changedBlockFraction(gray, prev, blockDiff) });
        drainDecisions(false);
      }
      prev = gray;
      prevT = mediaTime;
      onProgress?.(Math.min(mediaTime, duration), duration);
    };

    const tick = (_now?: number, meta?: { mediaTime: number }) => {
      if (settled) return;
      // MSE (.ts) playback may never fire `ended`; treat reaching the known
      // duration as completion too.
      if (video.ended || (duration > 0 && video.currentTime >= duration - 0.3)) return finish();
      sample(meta ? meta.mediaTime : video.currentTime);
      schedule();
    };
    const schedule = () => {
      if (settled) return;
      if (rvfc) rvfc(tick);
      else requestAnimationFrame((t) => tick(t));
    };

    try {
      video.playbackRate = playbackRate;
    } catch (_) {}
    schedule();
    if (document.hidden) {
      // Wait for visibility; the visibilitychange handler starts playback.
    } else {
      video.play().catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
    }
  });

  return { v: 1, duration, detector: DETECTOR, scenes: buildScenes(boundaries, duration, minSceneLen) };
}

const LABEL_FRAME_MAX_W = 512;

function waitPlayable(video: HTMLVideoElement, timeoutMs: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (video.error) {
        return reject(new Error(`video error: ${video.error.message || video.error.code}`));
      }
      if (!video.seeking && video.readyState >= 2 && video.videoWidth > 0) return resolve();
      if (Date.now() > deadline) return reject(new Error(message));
      window.setTimeout(tick, 200);
    };
    tick();
  });
}

/**
 * Seeks to each scene's midpoint on the (already loaded) scan video, captures
 * a keyframe, and asks the local labeler for a position tag. Best-effort:
 * frames that fail to seek or classify simply stay untagged.
 */
async function labelScenes(
  video: HTMLVideoElement,
  data: SceneData,
  opts: SceneDetectOptions
): Promise<void> {
  const { signal, onLabelProgress } = opts;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const total = data.scenes.length;
  let done = 0;
  let labeled = 0;
  onLabelProgress?.(done, total);
  for (const scene of data.scenes) {
    if (signal?.aborted) break;
    const mid = (scene.start + scene.end) / 2;
    try {
      video.currentTime = mid;
      await waitPlayable(video, 20000, 'label seek timeout');
      const scale = Math.min(1, LABEL_FRAME_MAX_W / (video.videoWidth || LABEL_FRAME_MAX_W));
      canvas.width = Math.round((video.videoWidth || 16) * scale);
      canvas.height = Math.round((video.videoHeight || 9) * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.8)
      );
      if (blob) {
        const label = await classifyFrame(blob);
        if (label?.position) {
          scene.position = label.position;
          scene.confidence = label.confidence;
          labeled++;
        }
      }
    } catch (err) {
      console.warn('Scene labelling failed at', mid, err);
    }
    done++;
    onLabelProgress?.(done, total);
  }
  if (labeled > 0) data.detector = `${data.detector}+labeler`;
}

/** Scans a local file (e.g. one that is currently uploading) — no network. */
export async function detectScenesFromFile(
  file: File,
  opts: SceneDetectOptions = {}
): Promise<SceneData> {
  await detectSem.acquire();
  const url = URL.createObjectURL(file);
  const video = makeVideo();
  try {
    video.src = url;
    await waitMetadata(video);
    const duration = video.duration;
    if (!isFinite(duration) || duration <= 0) throw new Error('invalid duration');
    const data = await runDetection(video, duration, opts);
    if (opts.withLabels) await labelScenes(video, data, opts);
    return data;
  } finally {
    teardownVideo(video);
    URL.revokeObjectURL(url);
    detectSem.release();
  }
}

/** Scans a file already stored in MEGA by streaming it once, start to end. */
export async function detectScenesFromNode(
  node: MegaFileLike,
  opts: SceneDetectOptions = {}
): Promise<SceneData> {
  await detectSem.acquire();
  try {
    if (isTransportStream(node.name)) {
      const video = makeVideo();
      let handle: TsPlayerHandle | null = null;
      try {
        handle = await attachTsPlayer(video, node);
        await waitMetadata(video);
        const duration = handle.duration || video.duration;
        if (!isFinite(duration) || duration <= 0) throw new Error('invalid duration');
        const data = await runDetection(video, duration, opts);
        if (opts.withLabels) await labelScenes(video, data, opts);
        return data;
      } finally {
        if (handle) {
          handle.destroy();
        } else {
          teardownVideo(video);
        }
      }
    }
    // Fewer connections than playback (4): a scan often runs while the same
    // file is being watched, and MEGA drops requests when too many parallel
    // transfer connections pile up.
    const { url, cleanup } = await createStreamUrl(node, { maxConnections: 2 });
    const video = makeVideo();
    try {
      video.src = url;
      await waitMetadata(video);
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) throw new Error('invalid duration');
      const data = await runDetection(video, duration, opts);
      if (opts.withLabels) await labelScenes(video, data, opts);
      return data;
    } finally {
      teardownVideo(video);
      cleanup();
    }
  } finally {
    detectSem.release();
  }
}

// ---------------------------------------------------------------------------
// Sidecar storage: .megastream/<nodeId>.scenes.json, same folder and node-id
// keying as the thumbnails.

export function scenesFileName(videoId: string): string {
  return `${videoId}.scenes.json`;
}

const cache = new Map<string, SceneData>();
const inflight = new Map<string, Promise<SceneData | null>>();

/** Loads previously generated scene data. Never generates anything. */
export async function getStoredScenes(
  videoId: string,
  node: MegaFileLike
): Promise<SceneData | null> {
  const hit = cache.get(videoId);
  if (hit) return hit;
  const existing = inflight.get(videoId);
  if (existing) return existing;

  const task = (async (): Promise<SceneData | null> => {
    try {
      const storage = node.storage;
      if (!storage?.root) return null;
      const folder = findThumbFolder(storage);
      if (!folder) return null;
      const target = ((folder.children || []) as MutableFile[]).find(
        (c) => !c.directory && c.name === scenesFileName(videoId)
      );
      if (!target) return null;
      const buf = await target.downloadBuffer({});
      const parsed = JSON.parse(new TextDecoder().decode(buf as unknown as Uint8Array));
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.scenes)) return null;
      cache.set(videoId, parsed as SceneData);
      return parsed as SceneData;
    } catch (err) {
      console.warn('Scene data load failed', err);
      return null;
    } finally {
      inflight.delete(videoId);
    }
  })();
  inflight.set(videoId, task);
  return task;
}

export async function saveScenes(storage: Storage, videoId: string, data: SceneData): Promise<void> {
  const folder = await ensureThumbFolder(storage);
  // Re-detection would otherwise pile up duplicate names — MEGA allows them.
  const name = scenesFileName(videoId);
  const stale = ((folder.children || []) as MutableFile[]).filter(
    (c) => !c.directory && c.name === name
  );
  for (const f of stale) {
    try {
      await f.delete(true);
    } catch (err) {
      console.warn('Failed to remove stale scene data', err);
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  await uploadBytes(folder, scenesFileName(videoId), bytes);
  cache.set(videoId, data);
  sceneEvents.dispatchEvent(new CustomEvent('scenes', { detail: videoId }));
}

export interface SceneGenProgress {
  done: number;
  total: number;
}

export interface SceneGenResult {
  generated: number;
  skipped: number;
  failed: number;
}

interface VideoEntry {
  id: string;
  name: string;
  node: MegaFileLike;
}

/**
 * Detects scenes for the given videos and stores the result as
 * `.megastream/<nodeId>.scenes.json`. Videos that already have scene data
 * are skipped. Sequential on purpose: each scan streams the whole file.
 */
export async function generateScenes(
  storage: Storage,
  videos: VideoEntry[],
  opts: { withLabels?: boolean; onProgress?: (p: SceneGenProgress) => void } = {}
): Promise<SceneGenResult> {
  const { withLabels = false, onProgress } = opts;
  const result: SceneGenResult = { generated: 0, skipped: 0, failed: 0 };
  if (videos.length === 0) return result;

  const folder = await ensureThumbFolder(storage);
  const existing = new Set(((folder.children || []) as MutableFile[]).map((c) => c.name));

  let done = 0;
  const report = () => onProgress?.({ done, total: videos.length });
  report();

  for (const video of videos) {
    if (existing.has(scenesFileName(video.id))) {
      result.skipped++;
      done++;
      report();
      continue;
    }
    try {
      const data = await detectScenesFromNode(video.node, { withLabels });
      await saveScenes(storage, video.id, data);
      result.generated++;
    } catch (err) {
      console.warn('Scene detection failed for', video.name, err);
      result.failed++;
    } finally {
      done++;
      report();
    }
  }

  return result;
}
