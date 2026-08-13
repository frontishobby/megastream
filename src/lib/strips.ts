// Animated scene strips: one sprite image per video with a frame from each
// scene's midpoint, stored as `.megastream/<nodeId>.strip-<frames>.webp`.
// FileCard shows the middle frame statically and cycles frames while the
// pointer hovers (or a touch is held). Sits on top of the scenes sidecar —
// videos without scene data keep their single-frame thumbnail.

import { createStreamUrl } from './stream';
import {
  Semaphore,
  ensureThumbFolder,
  findThumbFolder,
  uploadBytes,
  thumbnailEvents,
  getCached,
  setCached,
  blobToDataUrl,
  dataUrlToBytes,
} from './thumbnails';
import { getStoredScenes, type SceneData } from './scenes';
import type { Storage, MutableFile } from 'megajs';

interface MegaFileLike {
  size?: number;
  name?: string | null;
  storage?: Storage;
  download(opts: { start: number; end: number; maxConnections?: number }): any;
}

export interface StripData {
  url: string;
  frames: number;
}

interface CapturedStrip {
  dataUrl: string;
  ext: 'webp' | 'jpg';
  frames: number;
}

const MAX_FRAMES = 10;
const FRAME_W = 320;

const stripSem = new Semaphore(2);
const memCache = new Map<string, StripData>();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripRegex(videoId: string): RegExp {
  return new RegExp(`^${escapeRe(videoId)}\\.strip-(\\d+)\\.(webp|jpg)$`);
}

export function stripFileName(videoId: string, frames: number, ext: 'webp' | 'jpg'): string {
  return `${videoId}.strip-${frames}.${ext}`;
}

function findStripFile(
  storage: Storage,
  videoId: string
): { file: MutableFile; frames: number } | null {
  const folder = findThumbFolder(storage);
  if (!folder) return null;
  const re = stripRegex(videoId);
  for (const c of (folder.children || []) as MutableFile[]) {
    if (c.directory) continue;
    const m = re.exec(c.name || '');
    if (m) return { file: c, frames: parseInt(m[1], 10) };
  }
  return null;
}

/** Loads a previously generated strip. Never generates anything. */
export async function getStoredStrip(
  videoId: string,
  node: MegaFileLike
): Promise<StripData | null> {
  const hit = memCache.get(videoId);
  if (hit) return hit;
  const cached = await getCached(`strip:${videoId}`);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (typeof parsed?.url === 'string' && typeof parsed?.frames === 'number') {
        memCache.set(videoId, parsed);
        return parsed;
      }
    } catch (_) {}
  }
  try {
    const storage = node.storage;
    if (!storage?.root) return null;
    const found = findStripFile(storage, videoId);
    if (!found) return null;
    const buf = await found.file.downloadBuffer({});
    const mime = found.file.name?.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const url = await blobToDataUrl(new Blob([buf as unknown as BlobPart], { type: mime }));
    const data: StripData = { url, frames: found.frames };
    memCache.set(videoId, data);
    await setCached(`strip:${videoId}`, JSON.stringify(data));
    return data;
  } catch (err) {
    console.warn('Strip load failed', err);
    return null;
  }
}

/** Scene midpoints to capture, evenly thinned to MAX_FRAMES. */
function pickTimes(scenes: SceneData): number[] {
  const list = scenes.scenes;
  if (list.length === 0) return [];
  const idxs =
    list.length <= MAX_FRAMES
      ? list.map((_, i) => i)
      : Array.from({ length: MAX_FRAMES }, (_, k) => Math.floor((k * list.length) / MAX_FRAMES));
  return idxs.map((i) => (list[i].start + list[i].end) / 2);
}

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

function teardownVideo(video: HTMLVideoElement) {
  try {
    video.pause();
  } catch (_) {}
  video.removeAttribute('src');
  try {
    video.load();
  } catch (_) {}
}

async function captureStrip(video: HTMLVideoElement, times: number[]): Promise<CapturedStrip> {
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const fh = Math.round((FRAME_W * vh) / vw);
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W * times.length;
  canvas.height = fh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas context unavailable');
  for (let i = 0; i < times.length; i++) {
    try {
      video.currentTime = times[i];
      await waitSeekComplete(video, 15000);
    } catch (err) {
      if (video.error) throw err instanceof Error ? err : new Error(String(err));
      // Failed seek: draw whatever frame is current so the grid stays intact.
      console.warn('Strip seek failed at', times[i], err);
    }
    ctx.drawImage(video, i * FRAME_W, 0, FRAME_W, fh);
  }
  // Safari cannot encode WebP from canvas and silently returns PNG instead
  const webp = canvas.toDataURL('image/webp', 0.72);
  if (webp.startsWith('data:image/webp')) {
    return { dataUrl: webp, ext: 'webp', frames: times.length };
  }
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.72), ext: 'jpg', frames: times.length };
}

/** Captures a strip from a local file (upload path) — no network. */
export async function generateStripFromFile(
  file: File,
  scenes: SceneData
): Promise<CapturedStrip | null> {
  const times = pickTimes(scenes);
  if (times.length === 0) return null;
  await stripSem.acquire();
  const url = URL.createObjectURL(file);
  const video = makeVideo();
  try {
    video.src = url;
    await waitMetadata(video);
    return await captureStrip(video, times);
  } finally {
    teardownVideo(video);
    URL.revokeObjectURL(url);
    stripSem.release();
  }
}

/** Captures a strip from a MEGA node (one range download per scene). */
export async function generateStripFromNode(
  node: MegaFileLike,
  scenes: SceneData
): Promise<CapturedStrip | null> {
  const times = pickTimes(scenes);
  if (times.length === 0) return null;
  await stripSem.acquire();
  const { url, cleanup } = await createStreamUrl(node, { maxConnections: 2 });
  const video = makeVideo();
  try {
    video.src = url;
    await waitMetadata(video);
    return await captureStrip(video, times);
  } finally {
    teardownVideo(video);
    cleanup();
    stripSem.release();
  }
}

export async function saveStrip(
  storage: Storage,
  videoId: string,
  cap: CapturedStrip
): Promise<void> {
  const folder = await ensureThumbFolder(storage);
  const re = stripRegex(videoId);
  const stale = ((folder.children || []) as MutableFile[]).filter(
    (c) => !c.directory && re.test(c.name || '')
  );
  for (const f of stale) {
    try {
      await f.delete(true);
    } catch (err) {
      console.warn('Failed to remove stale strip', err);
    }
  }
  await uploadBytes(folder, stripFileName(videoId, cap.frames, cap.ext), dataUrlToBytes(cap.dataUrl));
  const data: StripData = { url: cap.dataUrl, frames: cap.frames };
  memCache.set(videoId, data);
  await setCached(`strip:${videoId}`, JSON.stringify(data));
  thumbnailEvents.dispatchEvent(new CustomEvent('thumbnail', { detail: videoId }));
}

export interface StripGenResult {
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
 * Generates strips for videos that have scene data but no strip yet.
 * Sequential: each strip costs one range download per scene.
 */
export async function generateStrips(
  storage: Storage,
  videos: VideoEntry[],
  onProgress?: (p: { done: number; total: number }) => void
): Promise<StripGenResult> {
  const result: StripGenResult = { generated: 0, skipped: 0, failed: 0 };
  if (videos.length === 0) return result;

  let done = 0;
  const report = () => onProgress?.({ done, total: videos.length });
  report();

  for (const video of videos) {
    try {
      if (findStripFile(storage, video.id)) {
        result.skipped++;
        continue;
      }
      const scenes = await getStoredScenes(video.id, video.node);
      if (!scenes || scenes.scenes.length === 0) {
        result.skipped++;
        continue;
      }
      const cap = await generateStripFromNode(video.node, scenes);
      if (!cap) {
        result.skipped++;
        continue;
      }
      await saveStrip(storage, video.id, cap);
      result.generated++;
    } catch (err) {
      console.warn('Strip generation failed for', video.name, err);
      result.failed++;
    } finally {
      done++;
      report();
    }
  }

  return result;
}
