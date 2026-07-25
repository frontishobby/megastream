import { createStreamUrl } from './stream';
import { attachTsPlayer, isTransportStream, type TsPlayerHandle } from './tsPlayer';
import type { Storage, MutableFile } from 'megajs';

const DB_NAME = 'megastream';
const STORE = 'thumbnails';
// v3: thumbnails now come from the .megastream folder; clear FA-era entries
const DB_VERSION = 3;

export const THUMB_FOLDER = '.megastream';

// Fired with the video node id as detail whenever a thumbnail becomes available.
export const thumbnailEvents = new EventTarget();

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) {
        db.deleteObjectStore(STORE);
      }
      db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function getCached(key: string): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as string) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

async function setCached(key: string, value: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {}
}

class Semaphore {
  private current = 0;
  private waiting: Array<() => void> = [];
  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.current++;
  }

  release() {
    this.current--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

const sem = new Semaphore(2);

interface MegaFileLike {
  size: number;
  name: string;
  download(opts: { start: number; end: number; maxConnections?: number }): any;
}

type ThumbExt = 'webp' | 'jpg';

interface CapturedFrame {
  dataUrl: string;
  ext: ThumbExt;
}

function encodeFrame(video: HTMLVideoElement): CapturedFrame {
  const maxW = 480;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(1, maxW / vw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas context unavailable');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  // Safari cannot encode WebP from canvas and silently returns PNG instead
  const webp = canvas.toDataURL('image/webp', 0.75);
  if (webp.startsWith('data:image/webp')) {
    return { dataUrl: webp, ext: 'webp' };
  }
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.75), ext: 'jpg' };
}

function waitFor(
  video: HTMLVideoElement,
  cond: () => boolean,
  timeoutMs: number,
  message: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (video.error) return reject(new Error(`video error: ${video.error.message || video.error.code}`));
      if (cond()) return resolve();
      if (Date.now() > deadline) return reject(new Error(message));
      window.setTimeout(tick, 200);
    };
    tick();
  });
}

// .ts can't be captured via <video src>; route it through the MSE transmuxer.
async function captureFrameTs(node: MegaFileLike): Promise<CapturedFrame> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  let handle: TsPlayerHandle | null = null;
  try {
    handle = await attachTsPlayer(video, node);
    await waitFor(video, () => video.readyState >= 1, 20000, 'metadata timeout');
    video.currentTime = handle.duration * 0.5;
    // The TS player may re-target the seek to where the probe actually
    // landed, so wait until a decodable frame exists at the final position.
    await waitFor(
      video,
      () => !video.seeking && video.readyState >= 2 && video.videoWidth > 0,
      45000,
      'seek timeout'
    );
    return encodeFrame(video);
  } finally {
    if (handle) {
      handle.destroy();
    } else {
      video.removeAttribute('src');
      try {
        video.load();
      } catch (_) {}
    }
  }
}

async function captureFrame(node: MegaFileLike): Promise<CapturedFrame> {
  if (isTransportStream(node.name)) return captureFrameTs(node);
  const { url, cleanup } = await createStreamUrl(node);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.crossOrigin = 'anonymous';

  try {
    video.src = url;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('metadata timeout'));
      }, 15000);
      const cleanupEvents = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanupEvents();
        resolve();
      };
      const onError = () => {
        cleanupEvents();
        reject(new Error('video load error'));
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);
    });

    if (!isFinite(video.duration) || video.duration <= 0) {
      throw new Error('invalid duration');
    }

    const targetTime = video.duration * 0.5;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('seek timeout'));
      }, 20000);
      const cleanupEvents = () => {
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
      };
      const onSeeked = () => {
        cleanupEvents();
        resolve();
      };
      const onError = () => {
        cleanupEvents();
        reject(new Error('seek error'));
      };
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      video.currentTime = targetTime;
    });

    return encodeFrame(video);
  } finally {
    try {
      video.pause();
    } catch (_) {}
    video.removeAttribute('src');
    try {
      video.load();
    } catch (_) {}
    cleanup();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function thumbFileName(videoId: string, ext: ThumbExt): string {
  return `${videoId}.${ext}`;
}

const THUMB_EXTS: ThumbExt[] = ['webp', 'jpg'];

function findThumbFolder(storage: Storage): MutableFile | null {
  const root = storage.root as unknown as MutableFile;
  const children = (root.children || []) as MutableFile[];
  return children.find((c) => c.directory && c.name === THUMB_FOLDER) ?? null;
}

function findThumbFile(storage: Storage, videoId: string): MutableFile | null {
  const folder = findThumbFolder(storage);
  if (!folder) return null;
  const children = (folder.children || []) as MutableFile[];
  const names = THUMB_EXTS.map((ext) => thumbFileName(videoId, ext));
  return children.find((c) => !c.directory && names.includes(c.name || '')) ?? null;
}

const inflight = new Map<string, Promise<string | null>>();

/**
 * Loads a previously generated thumbnail: IndexedDB cache first, then the
 * .megastream folder in the account. Never generates anything on its own.
 */
export async function getStoredThumbnail(
  videoId: string,
  node: MegaFileLike
): Promise<string | null> {
  const cached = await getCached(videoId);
  if (cached) return cached;

  const existing = inflight.get(videoId);
  if (existing) return existing;

  const task = (async () => {
    try {
      const storage = (node as { storage?: Storage }).storage;
      if (!storage?.root) return null;
      const thumbFile = findThumbFile(storage, videoId);
      if (!thumbFile) return null;
      const buf = await thumbFile.downloadBuffer({});
      const mime = thumbFile.name?.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      const dataUrl = await blobToDataUrl(
        new Blob([buf as unknown as BlobPart], { type: mime })
      );
      await setCached(videoId, dataUrl);
      return dataUrl;
    } catch (err) {
      console.warn('Thumbnail load failed', err);
      return null;
    } finally {
      inflight.delete(videoId);
    }
  })();
  inflight.set(videoId, task);
  return task;
}

export interface ThumbGenProgress {
  done: number;
  total: number;
}

export interface ThumbGenResult {
  generated: number;
  skipped: number;
  failed: number;
}

interface VideoEntry {
  id: string;
  name: string;
  node: MegaFileLike;
}

async function ensureThumbFolder(storage: Storage): Promise<MutableFile> {
  const existing = findThumbFolder(storage);
  if (existing) return existing;
  const root = storage.root as unknown as MutableFile;
  return (await root.mkdir({ name: THUMB_FOLDER })) as unknown as MutableFile;
}

function uploadBytes(folder: MutableFile, name: string, bytes: Uint8Array): Promise<void> {
  const stream = (folder as unknown as {
    upload(opts: { name: string; size: number }): {
      end(data: Uint8Array): void;
      complete: Promise<unknown>;
    };
  }).upload({ name, size: bytes.length });
  stream.end(bytes);
  return stream.complete.then(() => undefined);
}

/**
 * Generates thumbnails for the given videos and stores them as
 * `.megastream/<nodeId>.jpg` in the account. Videos that already have a
 * stored thumbnail are skipped.
 */
export async function generateThumbnails(
  storage: Storage,
  videos: VideoEntry[],
  onProgress?: (p: ThumbGenProgress) => void
): Promise<ThumbGenResult> {
  const result: ThumbGenResult = { generated: 0, skipped: 0, failed: 0 };
  if (videos.length === 0) return result;

  const folder = await ensureThumbFolder(storage);
  const existing = new Set(
    ((folder.children || []) as MutableFile[]).map((c) => c.name)
  );

  let done = 0;
  const report = () => onProgress?.({ done, total: videos.length });
  report();

  await Promise.all(
    videos.map(async (video) => {
      if (THUMB_EXTS.some((ext) => existing.has(thumbFileName(video.id, ext)))) {
        result.skipped++;
        done++;
        report();
        return;
      }
      await sem.acquire();
      try {
        const { dataUrl, ext } = await captureFrame(video.node);
        await uploadBytes(folder, thumbFileName(video.id, ext), dataUrlToBytes(dataUrl));
        await setCached(video.id, dataUrl);
        thumbnailEvents.dispatchEvent(new CustomEvent('thumbnail', { detail: video.id }));
        result.generated++;
      } catch (err) {
        console.warn('Thumbnail generation failed for', video.name, err);
        result.failed++;
      } finally {
        sem.release();
        done++;
        report();
      }
    })
  );

  return result;
}
