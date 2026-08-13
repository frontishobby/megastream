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
  /**
   * Runner-up label when the scene is genuinely mixed (group scenes with
   * simultaneous acts) — the primary label held less than ~55% of the vote.
   */
  alt?: string;
}

export interface VideoTag {
  /** booru tag name */
  t: string;
  /** score = presence × mean confidence */
  s: number;
}

/**
 * Raw per-frame classification, persisted so smoothing, label groupings,
 * priority thresholds and tag aggregation can all be recomputed later
 * WITHOUT rescanning the video (a full-library scan is expensive).
 */
export interface SweepSample {
  t: number;
  /** chosen position label */
  p: string | null;
  /** its confidence */
  c: number | null;
  /** every position candidate's best tag probability */
  pos?: Record<string, number>;
  /** general tags (conf >= 0.25) */
  tags?: Record<string, number>;
}

export interface SceneData {
  v: 1;
  duration: number;
  detector: string;
  scenes: Scene[];
  /** Video-level descriptive tags aggregated across labelled frames. */
  videoTags?: VideoTag[];
  /** Raw sweep samples (labelled scans only). */
  samples?: SweepSample[];
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
  /** Minimum scene length, seconds (default 1.5 static / 30 labeled). */
  minSceneLen?: number;
  /**
   * Label mode: sliding majority-vote window in samples (odd). With multiple
   * performers the tagger oscillates between two labels frame to frame;
   * per-sample majority over this window kills the oscillation.
   */
  smoothWindow?: number;
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
// v4: sidecars now include the raw sample sequence.
const SWEEP_DETECTOR = 'label-sweep-v4';
const STORED_TAG_MIN = 0.25;

interface InternalSample {
  t: number;
  position: string | null;
  confidence: number | null;
  positions?: Record<string, number>;
  tags?: Record<string, number>;
}

function compactSamples(samples: InternalSample[]): SweepSample[] {
  return samples.map((s) => {
    const out: SweepSample = { t: s.t, p: s.position, c: s.confidence };
    if (s.positions && Object.keys(s.positions).length > 0) {
      out.pos = s.positions;
    }
    if (s.tags) {
      const kept: Record<string, number> = {};
      for (const [tag, conf] of Object.entries(s.tags)) {
        if (conf >= STORED_TAG_MIN) kept[tag] = round2(conf);
      }
      if (Object.keys(kept).length > 0) out.tags = kept;
    }
    return out;
  });
}
// Vote weight of a "none" sample: low enough that close-up/ambiguous blips
// get absorbed by surrounding labels, high enough that genuinely idle
// stretches still win.
const NONE_WEIGHT = 0.3;
// A scene is "mixed" when its primary label holds under this share…
const ALT_SHARE_CEILING = 0.55;
// …and the runner-up holds at least this much.
const ALT_MIN_SHARE = 0.2;

// Tags that appear on virtually every frame in this domain (or duplicate the
// position labels) carry no information about a specific video — drop them
// before aggregating. Tune freely.
const TAG_BLOCKLIST = new Set([
  // ubiquitous subjects/anatomy
  '1girl', '1boy', '2girls', '2boys', 'multiple_girls', 'multiple_boys',
  'solo', 'solo_focus', 'nude', 'completely_nude', 'topless', 'bottomless',
  'breasts', 'nipples', 'penis', 'pussy', 'anus', 'ass', 'testicles',
  'erection', 'navel', 'barefoot', 'collarbone', 'thighs',
  // ubiquitous acts/states
  'sex', 'vaginal', 'hetero', 'sweat', 'blush', 'open_mouth', 'closed_eyes',
  'lying', 'spread_legs', 'on_back', 'on_bed', 'bed', 'bed_sheet', 'pillow',
  'indoors', 'long_hair',
  // medium/censoring
  'censored', 'uncensored', 'mosaic_censoring', 'bar_censor',
  'photorealistic', 'realistic', 'photo_(medium)',
  // position tags — already expressed as scene labels
  'missionary', 'doggystyle', 'sex_from_behind', 'bent_over',
  'cowgirl_position', 'girl_on_top', 'upright_straddle',
  'reverse_cowgirl_position', 'spooning', 'standing_sex',
  'suspended_congress', 'fellatio', 'irrumatio', 'deepthroat',
  'cunnilingus', '69', 'paizuri', 'handjob', 'masturbation', 'fingering',
  'oral',
]);
const TAG_PRESENT_CONF = 0.35;
const TAG_MIN_PRESENCE = 0.2;
const MAX_VIDEO_TAGS = 6;

/**
 * Video-level tags: a tag qualifies when it shows up (conf ≥ 0.35) in at
 * least 20% of labelled frames — a property of the video, not one moment —
 * and tags are ranked by presence × mean confidence.
 */
function aggregateVideoTags(samples: Array<{ tags?: Record<string, number> }>): VideoTag[] {
  const tagged = samples.filter((s) => s.tags && Object.keys(s.tags).length > 0);
  if (tagged.length === 0) return [];
  const acc = new Map<string, { present: number; confSum: number; count: number }>();
  for (const s of tagged) {
    for (const [tag, conf] of Object.entries(s.tags!)) {
      if (TAG_BLOCKLIST.has(tag)) continue;
      let e = acc.get(tag);
      if (!e) {
        e = { present: 0, confSum: 0, count: 0 };
        acc.set(tag, e);
      }
      if (conf >= TAG_PRESENT_CONF) e.present++;
      e.confSum += conf;
      e.count++;
    }
  }
  const out: VideoTag[] = [];
  for (const [tag, e] of acc) {
    const presence = e.present / tagged.length;
    if (presence < TAG_MIN_PRESENCE) continue;
    out.push({ t: tag, s: round2(presence * (e.confSum / e.count)) });
  }
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, MAX_VIDEO_TAGS);
}

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
  const {
    labelInterval = 4,
    minSceneLen = 30,
    smoothWindow = 7,
    playbackRate = 4,
    signal,
    onProgress,
  } = opts;

  let prevT = -Infinity;
  let attempts = 0;
  const samples: InternalSample[] = [];
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
      const label = await classifyFrame(blob, mediaTime);
      if (!label) return; // request failed — no vote, not a "none"
      samples.push({
        t: mediaTime,
        position: label.position,
        confidence: label.confidence,
        positions: label.positions,
        tags: label.tags,
      });
    });
  };

  await runPlaybackPass(video, duration, { playbackRate, signal, onProgress }, capture);
  await chain;

  if (attempts > 0 && samples.length === 0) {
    throw new Error('labeler did not respond during the scan');
  }

  const data: SceneData = {
    v: 1,
    duration,
    detector: SWEEP_DETECTOR,
    scenes: buildLabeledScenes(samples, duration, minSceneLen, labelInterval, smoothWindow),
    videoTags: aggregateVideoTags(samples),
    samples: compactSamples(samples),
  };
  dumpSweepDebug(samples, data);
  return data;
}

// One-line JSON dumps for diagnosing label quality: copy the
// "[scene-scan] samples" line from the console to see exactly what the
// tagger said at every timestamp before smoothing/merging.
function dumpSweepDebug(
  samples: Array<{ t: number; position: string | null; confidence: number | null }>,
  data: SceneData
) {
  try {
    // Chunked: the browser truncates very long console strings when saving
    // logs, which cuts off exactly the part someone needs.
    const compact = samples.map((s) => ({ t: s.t, p: s.position, c: s.confidence }));
    const CHUNK = 60;
    for (let i = 0; i < compact.length; i += CHUNK) {
      console.log(
        `[scene-scan] samples ${i / CHUNK + 1}/${Math.ceil(compact.length / CHUNK)} (${data.detector}): ` +
          JSON.stringify(compact.slice(i, i + CHUNK))
      );
    }
    console.log('[scene-scan] scenes: ' + JSON.stringify(data.scenes));
  } catch (_) {}
}

function waitSeekComplete(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (video.error) {
        return reject(new Error(`video error: ${video.error.message || video.error.code}`));
      }
      if (!video.seeking && video.readyState >= 2 && video.videoWidth > 0) return resolve();
      if (Date.now() > deadline) return reject(new Error('seek timeout'));
      window.setTimeout(check, 40);
    };
    check();
  });
}

/**
 * Seek-stepping variant of the label sweep for local files: instead of
 * playing the video through in real time, jump straight to each sample
 * point and capture it. Local random access makes a seek cost ~100ms of
 * decode, so a 30-minute file scans in about a minute instead of the 7.5
 * minutes a 4x playback pass takes — and the GPU stays busy because
 * classification runs while the next seek is decoding. Remote streams keep
 * the playback pass: there each seek would trigger fresh range downloads.
 */
async function runLabelSweepSeek(
  video: HTMLVideoElement,
  duration: number,
  opts: SceneDetectOptions
): Promise<SceneData> {
  const { labelInterval = 4, minSceneLen = 30, smoothWindow = 7, signal, onProgress } = opts;

  const samples: InternalSample[] = [];
  const tasks: Promise<void>[] = [];
  let attempts = 0;

  // Sample mid-interval (2s, 6s, …) so the first point is a real seek and
  // each frame represents its surrounding interval.
  for (let t = labelInterval / 2; t < duration - 0.25; t += labelInterval) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      video.currentTime = t;
      await waitSeekComplete(video, 15000);
    } catch (err) {
      if (video.error) throw err instanceof Error ? err : new Error(String(err));
      console.warn('Label seek failed at', t, err);
      continue;
    }
    // Fresh canvas per capture: encoding + classification run async while
    // the loop seeks on.
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, LABEL_FRAME_MAX_W / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (_) {
      continue;
    }
    attempts++;
    const at = t;
    tasks.push(
      (async () => {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', 0.8)
        );
        if (!blob) return;
        const label = await classifyFrame(blob, at);
        if (!label) return; // request failed — no vote, not a "none"
        samples.push({
          t: at,
          position: label.position,
          confidence: label.confidence,
          positions: label.positions,
          tags: label.tags,
        });
      })()
    );
    onProgress?.(Math.min(t, duration), duration);
  }

  await Promise.all(tasks);

  if (attempts > 0 && samples.length === 0) {
    throw new Error('labeler did not respond during the scan');
  }
  // Classification finishes out of order; the run builder needs time order.
  samples.sort((a, b) => a.t - b.t);

  const data: SceneData = {
    v: 1,
    duration,
    detector: SWEEP_DETECTOR,
    scenes: buildLabeledScenes(samples, duration, minSceneLen, labelInterval, smoothWindow),
    videoTags: aggregateVideoTags(samples),
    samples: compactSamples(samples),
  };
  dumpSweepDebug(samples, data);
  return data;
}

/**
 * Turns the label sample sequence into scenes in three steps:
 *
 * 1. Sliding majority vote — each sample is relabelled to the
 *    confidence-weighted majority of its surrounding window, which absorbs
 *    both single misclassifications and two-label oscillation in
 *    multi-performer scenes.
 * 2. Runs of identical smoothed labels become scenes.
 * 3. Scenes shorter than minSceneLen are folded into their longer
 *    neighbour until every scene meets the minimum.
 */
function buildLabeledScenes(
  samples: Array<{ t: number; position: string | null; confidence: number | null }>,
  duration: number,
  minSceneLen: number,
  labelInterval: number,
  smoothWindow: number
): Scene[] {
  const wholeVideo: Scene = {
    i: 0,
    start: 0,
    end: round2(duration),
    position: null,
    confidence: null,
  };
  if (samples.length === 0) return [wholeVideo];

  // 1) Majority smoothing over confidence-weighted votes.
  const half = Math.max(1, Math.floor(smoothWindow / 2));
  const weightOf = (s: { confidence: number | null }) => s.confidence ?? NONE_WEIGHT;
  const smoothed: string[] = samples.map((_, i) => {
    const votes = new Map<string, number>();
    for (let k = Math.max(0, i - half); k <= Math.min(samples.length - 1, i + half); k++) {
      const label = samples[k].position ?? 'none';
      votes.set(label, (votes.get(label) ?? 0) + weightOf(samples[k]));
    }
    let best = 'none';
    let bestW = -1;
    for (const [label, w] of votes) {
      if (w > bestW) {
        best = label;
        bestW = w;
      }
    }
    return best;
  });

  // 2) Runs of identical smoothed labels.
  interface Segment {
    start: number;
    end: number;
    label: string;
    confs: number[];
  }
  const segments: Segment[] = [];
  for (let i = 0; i < samples.length; i++) {
    const label = smoothed[i];
    const last = segments[segments.length - 1];
    if (last && last.label === label) {
      if (samples[i].confidence != null) last.confs.push(samples[i].confidence!);
      continue;
    }
    // The transition happened somewhere in the interval before this sample.
    const start = last ? Math.max(last.start, round2(samples[i].t - labelInterval / 2)) : 0;
    if (last) last.end = start;
    segments.push({
      start,
      end: duration,
      label,
      confs: samples[i].confidence != null ? [samples[i].confidence!] : [],
    });
  }

  // 3) Fold sub-minimum scenes into their longer neighbour (coalescing
  // same-label neighbours as they meet) until everything is long enough.
  let changed = true;
  while (changed && segments.length > 1) {
    changed = false;
    for (let i = segments.length - 2; i >= 0; i--) {
      if (segments[i].label === segments[i + 1].label) {
        segments[i].end = segments[i + 1].end;
        segments[i].confs.push(...segments[i + 1].confs);
        segments.splice(i + 1, 1);
        changed = true;
      }
    }
    let idx = -1;
    let shortest = Infinity;
    for (let i = 0; i < segments.length; i++) {
      const len = segments[i].end - segments[i].start;
      if (len < minSceneLen && len < shortest) {
        shortest = len;
        idx = i;
      }
    }
    if (idx === -1 || segments.length <= 1) break;
    const prev = idx > 0 ? segments[idx - 1] : null;
    const next = idx < segments.length - 1 ? segments[idx + 1] : null;
    const intoPrev =
      prev && (!next || prev.end - prev.start >= next.end - next.start);
    if (intoPrev && prev) {
      prev.end = segments[idx].end;
    } else if (next) {
      next.start = segments[idx].start;
    }
    segments.splice(idx, 1);
    changed = true;
  }

  const scenes: Scene[] = segments.map((seg, i) => {
    const scene: Scene = {
      i,
      start: round2(seg.start),
      end: round2(seg.end),
      position: seg.label === 'none' ? null : seg.label,
      confidence: seg.confs.length
        ? round2(seg.confs.reduce((a, b) => a + b, 0) / seg.confs.length)
        : null,
    };
    // Mixed-scene detection: group scenes run several acts at once and the
    // per-frame label follows the camera. When the raw votes inside the
    // final range are split, surface the runner-up too.
    if (scene.position) {
      const votes = new Map<string, number>();
      let total = 0;
      for (const s of samples) {
        if (s.t < seg.start || s.t >= seg.end) continue;
        const label = s.position ?? 'none';
        const w = weightOf(s);
        votes.set(label, (votes.get(label) ?? 0) + w);
        total += w;
      }
      const primaryShare = total > 0 ? (votes.get(seg.label) ?? 0) / total : 1;
      if (primaryShare < ALT_SHARE_CEILING) {
        let altLabel: string | null = null;
        let altW = 0;
        for (const [label, w] of votes) {
          if (label === seg.label || label === 'none') continue;
          if (w > altW) {
            altW = w;
            altLabel = label;
          }
        }
        if (altLabel && total > 0 && altW / total >= ALT_MIN_SHARE) scene.alt = altLabel;
      }
    }
    return scene;
  });
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
    // Local files have free random access — seek-step instead of playing
    // the whole file through.
    return opts.withLabels
      ? await runLabelSweepSeek(video, duration, opts)
      : await runDetection(video, duration, opts);
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

export async function saveScenes(
  storage: Storage,
  videoId: string,
  data: SceneData,
  // When the video node is provided, the aggregated tags are mirrored into
  // its `_tags` attribute (same mechanism as `_memo`) so the folder listing
  // can show them without fetching any sidecars.
  videoNode?: MutableFile
): Promise<void> {
  const folder = await ensureThumbFolder(storage);
  // Re-detection would otherwise pile up duplicate names — MEGA allows them.
  // Scene strips are derived from this data, so drop them too; the next
  // strip generation rebuilds them from the fresh scenes.
  const name = scenesFileName(videoId);
  const stale = ((folder.children || []) as MutableFile[]).filter(
    (c) => !c.directory && (c.name === name || (c.name || '').startsWith(`${videoId}.strip-`))
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
  if (videoNode) {
    const value = data.videoTags?.length
      ? data.videoTags.map((v) => v.t).join(',')
      : undefined; // clears stale tags when a rescan produced none
    try {
      await videoNode.setAttributes({ _tags: value } as unknown as JSON);
    } catch (err) {
      console.warn('Failed to save video tags', err);
    }
  }
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
 * `.megastream/<nodeId>.scenes.json`. Skipping is version-aware in labelled
 * mode: sidecars from older detectors (static fallback, pre-v4 sweeps) get
 * re-scanned, so one button press upgrades the whole library and an
 * interrupted batch resumes where it left off. Sequential on purpose: each
 * scan streams the whole file.
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
    let skip = false;
    if (withLabels) {
      const stored = existing.has(scenesFileName(video.id))
        ? await getStoredScenes(video.id, video.node)
        : null;
      skip = stored?.detector === SWEEP_DETECTOR;
    } else {
      // Static fallback can't improve on any existing data.
      skip = existing.has(scenesFileName(video.id));
    }
    if (skip) {
      result.skipped++;
      done++;
      report();
      continue;
    }
    try {
      const data = await detectScenesFromNode(video.node, { withLabels });
      await saveScenes(storage, video.id, data, video.node as unknown as MutableFile);
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
