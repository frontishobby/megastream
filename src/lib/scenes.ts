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
  /**
   * Use the local labeler to segment: frames are classified every
   * `labelInterval` seconds and scenes are runs of identical position
   * labels. Without it, the static cut detector runs instead.
   */
  withLabels?: boolean;
  /** Seconds of media time between classified frames in label mode. */
  labelInterval?: number;
  signal?: AbortSignal;
  onProgress?: (processedSec: number, durationSec: number) => void;
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
 * Shared playback harness: plays the (muted, sped-up) video once, calling
 * `onFrame(mediaTime)` for each presented frame. Handles hidden-tab pausing
 * (rVFC stops firing there, which would silently skip frames), a stall
 * watchdog, aborts, and MSE streams that never fire `ended`.
 */
function runPlaybackPass(
  video: HTMLVideoElement,
  duration: number,
  opts: { playbackRate: number; signal?: AbortSignal; onProgress?: SceneDetectOptions['onProgress'] },
  onFrame: (mediaTime: number) => void
): Promise<void> {
  const { playbackRate, signal, onProgress } = opts;
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const rvfc: ((cb: (now: number, meta: { mediaTime: number }) => void) => void) | undefined = (
      video as any
    ).requestVideoFrameCallback?.bind(video);

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
      if (err) reject(err);
      else resolve();
    };
    const onEnded = () => finish();
    const onError = () =>
      finish(new Error(`video error: ${video.error?.message || video.error?.code || 'unknown'}`));
    const onAbort = () => finish(new DOMException('Aborted', 'AbortError') as unknown as Error);

    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    document.addEventListener('visibilitychange', onVisibility);
    signal?.addEventListener('abort', onAbort);

    const tick = (_now?: number, meta?: { mediaTime: number }) => {
      if (settled) return;
      // MSE (.ts) playback may never fire `ended`; treat reaching the known
      // duration as completion too.
      if (video.ended || (duration > 0 && video.currentTime >= duration - 0.3)) return finish();
      const mediaTime = meta ? meta.mediaTime : video.currentTime;
      onFrame(mediaTime);
      onProgress?.(Math.min(mediaTime, duration), duration);
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
}

/**
 * Static detector: flags hard cuts. Each sampled frame pair gets a
 * changed-block fraction (how much of the frame changed, not how strongly),
 * and a cut must be a *peak*: a single-sample spike that clearly exceeds
 * both the preceding and following samples. Sustained high fractions (whip
 * pans, close-up motion) never form a peak, and localized motion never
 * changes enough blocks.
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

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas context unavailable');

  const boundaries: number[] = [];
  let prev: Uint8Array | null = null;
  let prevT = -Infinity;
  let lastCut = 0;

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
  };

  await runPlaybackPass(video, duration, { playbackRate, signal, onProgress }, sample);
  drainDecisions(true);

  return { v: 1, duration, detector: DETECTOR, scenes: buildScenes(boundaries, duration, minSceneLen) };
}

const LABEL_FRAME_MAX_W = 512;
const SWEEP_DETECTOR = 'label-sweep-v1';

/**
 * Labeler-driven detector: samples a frame every `labelInterval` seconds
 * during the playback pass, classifies each via the local labeler, and turns
 * runs of identical position labels into scenes. Camera cuts within the same
 * position merge; position changes inside a single take split — scene
 * boundaries follow what is happening, not how it was edited.
 */
async function runLabelSweep(
  video: HTMLVideoElement,
  duration: number,
  opts: SceneDetectOptions
): Promise<SceneData> {
  const { labelInterval = 4, minSceneLen = 1.5, playbackRate = 4, signal, onProgress } = opts;

  let prevT = -Infinity;
  let attempts = 0;
  const samples: Array<{ t: number; position: string | null; confidence: number | null }> = [];
  // Serial classification queue: at 4x playback a sample arrives roughly
  // once per wall-clock second and GPU classification is far faster, so the
  // queue drains as it fills; playback never waits on it.
  let chain: Promise<void> = Promise.resolve();

  const capture = (mediaTime: number) => {
    if (mediaTime - prevT < labelInterval) return;
    if (!video.videoWidth) return;
    prevT = mediaTime;
    // Fresh canvas per capture: encoding happens async in the queue and a
    // shared canvas would be overwritten by the next sample.
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, LABEL_FRAME_MAX_W / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (_) {
      return;
    }
    attempts++;
    chain = chain.then(async () => {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.8)
      );
      if (!blob) return;
      const label = await classifyFrame(blob);
      if (!label) return; // request failed — no vote, not a "none"
      samples.push({ t: mediaTime, position: label.position, confidence: label.confidence });
    });
  };

  await runPlaybackPass(video, duration, { playbackRate, signal, onProgress }, capture);
  await chain;

  if (attempts > 0 && samples.length === 0) {
    throw new Error('labeler did not respond during the scan');
  }

  return {
    v: 1,
    duration,
    detector: SWEEP_DETECTOR,
    scenes: buildLabeledScenes(samples, duration, minSceneLen, labelInterval),
  };
}

/**
 * Turns the label sample sequence into scenes. Hysteresis smoothing: the
 * label only switches when two consecutive samples agree on the new label,
 * so a single misclassified frame never splits a scene.
 */
function buildLabeledScenes(
  samples: Array<{ t: number; position: string | null; confidence: number | null }>,
  duration: number,
  minSceneLen: number,
  labelInterval: number
): Scene[] {
  const wholeVideo: Scene = {
    i: 0,
    start: 0,
    end: round2(duration),
    position: null,
    confidence: null,
  };
  if (samples.length === 0) return [wholeVideo];

  interface Run {
    label: string;
    start: number;
    confs: number[];
  }
  const runs: Run[] = [];
  let cur: Run | null = null;
  let pending: { label: string; t: number; conf: number | null } | null = null;

  for (const s of samples) {
    const label = s.position ?? 'none';
    if (!cur) {
      cur = { label, start: 0, confs: s.confidence != null ? [s.confidence] : [] };
      runs.push(cur);
      continue;
    }
    if (label === cur.label) {
      if (s.confidence != null) cur.confs.push(s.confidence);
      pending = null;
      continue;
    }
    if (pending && pending.label === label) {
      // Two consecutive samples agree on a new label: switch, placing the
      // boundary just before the first sample of the pair (the transition
      // happened somewhere in the preceding interval).
      const start = Math.max(cur.start, round2(pending.t - labelInterval / 2));
      cur = { label, start, confs: [] };
      if (pending.conf != null) cur.confs.push(pending.conf);
      if (s.confidence != null) cur.confs.push(s.confidence);
      runs.push(cur);
      pending = null;
    } else {
      pending = { label, t: s.t, conf: s.confidence };
    }
  }

  const scenes: Scene[] = [];
  for (let k = 0; k < runs.length; k++) {
    const start = runs[k].start;
    const end = k + 1 < runs.length ? runs[k + 1].start : duration;
    if (end - start <= 0) continue;
    const confs = runs[k].confs;
    scenes.push({
      i: scenes.length,
      start: round2(start),
      end: round2(end),
      position: runs[k].label === 'none' ? null : runs[k].label,
      confidence: confs.length
        ? round2(confs.reduce((a, b) => a + b, 0) / confs.length)
        : null,
    });
  }
  // Fold a too-short tail into the previous scene.
  if (scenes.length >= 2) {
    const tail = scenes[scenes.length - 1];
    if (tail.end - tail.start < minSceneLen) {
      scenes[scenes.length - 2].end = tail.end;
      scenes.pop();
    }
  }
  return scenes.length ? scenes : [wholeVideo];
}

function detectWith(
  video: HTMLVideoElement,
  duration: number,
  opts: SceneDetectOptions
): Promise<SceneData> {
  return opts.withLabels ? runLabelSweep(video, duration, opts) : runDetection(video, duration, opts);
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
    return await detectWith(video, duration, opts);
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
        return await detectWith(video, duration, opts);
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
      return await detectWith(video, duration, opts);
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
