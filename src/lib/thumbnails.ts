import { createStreamUrl } from './stream';
import { fetchFileAttribute } from './fileAttribute';
import type { File as MegaFile } from 'megajs';

const DB_NAME = 'megastream';
const STORE = 'thumbnails';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
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

async function captureFrame(node: MegaFileLike): Promise<string> {
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
    return canvas.toDataURL('image/jpeg', 0.75);
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

const inflight = new Map<string, Promise<string | null>>();

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchFromMega(node: MegaFile): Promise<string | null> {
  try {
    const blob = await fetchFileAttribute(node, 0);
    if (!blob) return null;
    return await blobToDataUrl(blob);
  } catch (err) {
    console.warn('FA thumbnail fetch failed', err);
    return null;
  }
}

export async function getThumbnail(
  cacheKey: string,
  node: MegaFileLike
): Promise<string | null> {
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const task = (async () => {
    try {
      const fromFa = await fetchFromMega(node as unknown as MegaFile);
      if (fromFa) {
        await setCached(cacheKey, fromFa);
        return fromFa;
      }

      await sem.acquire();
      try {
        const dataUrl = await captureFrame(node);
        await setCached(cacheKey, dataUrl);
        return dataUrl;
      } catch (err) {
        console.warn('Thumbnail generation failed for', node.name, err);
        return null;
      } finally {
        sem.release();
      }
    } finally {
      inflight.delete(cacheKey);
    }
  })();
  inflight.set(cacheKey, task);
  return task;
}
