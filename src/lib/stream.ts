import { showStreamErrorToast } from './toast.svelte';

interface MegaFileLike {
  // megajs types size/name as optional; createStreamUrl rejects at runtime if
  // the size is absent
  size?: number;
  name?: string | null;
  nodeId?: string;
  key?: Uint8Array | null;
  // megajs's own types declare the request body as the global JSON type
  api?: { request(json: any): Promise<any> };
  download(opts: {
    start: number;
    end: number;
    maxConnections?: number;
    initialChunkSize?: number;
    chunkSizeIncrement?: number;
    maxChunkSize?: number;
  }): any;
}

interface FetchRangeMessage {
  type: 'fetch-range';
  sessionId: string;
  start: number;
  end: number;
}

// What the service worker needs to pull ciphertext off the MEGA CDN and
// decrypt it itself, without routing bytes through the page.
interface DirectInfo {
  aesKey: ArrayBuffer;
  nonce: ArrayBuffer;
  url: string;
}

interface SessionEntry {
  node: MegaFileLike;
  direct: DirectInfo | null;
}

const activeSessions = new Map<string, SessionEntry>();
let swReadyPromise: Promise<void> | null = null;
let messageHandlerInstalled = false;

// MPEG-TS playback support was removed; .ts files stay listed so previously
// generated thumbnails remain visible, but they can't be played or scanned.
export function isTransportStream(name: string | null | undefined): boolean {
  if (!name) return false;
  return name.toLowerCase().endsWith('.ts');
}

export function isServiceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export async function ensureServiceWorker(): Promise<void> {
  if (!isServiceWorkerSupported()) {
    throw new Error('Service Worker not supported in this browser');
  }
  if (swReadyPromise) return swReadyPromise;
  swReadyPromise = (async () => {
    await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const handler = () => {
          navigator.serviceWorker.removeEventListener('controllerchange', handler);
          resolve();
        };
        navigator.serviceWorker.addEventListener('controllerchange', handler);
      });
    }
    installMessageHandler();
  })();
  return swReadyPromise;
}

function installMessageHandler() {
  if (messageHandlerInstalled) return;
  messageHandlerInstalled = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === 'stream-error') {
      showStreamErrorToast('Streaming failed', new Error(data.message || 'Stream error'));
      return;
    }
    const port = event.ports[0];
    if (!port) return;
    if (data.type === 'fetch-range') {
      handleFetchRange(data as FetchRangeMessage, port);
    } else if (data.type === 'resolve-session') {
      handleResolveSession(data.sessionId, port);
    } else if (data.type === 'refresh-url') {
      handleRefreshUrl(data.sessionId, port);
    }
  });
}

// --- Direct-mode key material -------------------------------------------

// A MEGA file key is 32 bytes: the AES key XORed with the MAC in the first
// half, and nonce (8 bytes) + MAC in the second. The service worker only needs
// the unmerged AES key and the nonce.
function deriveDirectKeys(key: Uint8Array | null | undefined): { aesKey: ArrayBuffer; nonce: ArrayBuffer } | null {
  if (!key || key.length < 32) return null;
  const aes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) aes[i] = key[i] ^ key[16 + i];
  const nonce = new Uint8Array(8);
  nonce.set(key.subarray(16, 24));
  return { aesKey: aes.buffer, nonce: nonce.buffer };
}

// Same `g` call megajs makes at the top of node.download(): returns a CDN URL
// that accepts `/<start>-<end>` byte ranges. Valid for a while, then 403s.
async function fetchDownloadUrl(node: MegaFileLike): Promise<string | null> {
  if (!node.api || !node.nodeId) return null;
  const ssl = typeof window !== 'undefined' && window.isSecureContext ? 2 : 0;
  const res = await node.api.request({ a: 'g', g: 1, ssl, n: node.nodeId });
  if (!res || typeof res.g !== 'string' || !res.g.startsWith('http')) return null;
  return res.g as string;
}

async function buildDirectInfo(node: MegaFileLike): Promise<DirectInfo | null> {
  const keys = deriveDirectKeys(node.key);
  if (!keys) return null;
  try {
    const url = await fetchDownloadUrl(node);
    if (!url) return null;
    return { ...keys, url };
  } catch (err) {
    console.warn('Direct streaming unavailable, falling back to page-side download:', err);
    return null;
  }
}

function sessionInfo(session: SessionEntry) {
  return {
    size: session.node.size,
    mimeType: getMimeType(session.node.name || ''),
    direct: session.direct,
  };
}

// A restarted service worker (idle-killed, empty session map) asks pages to
// re-register sessions so playback continues instead of 404ing mid-stream.
function handleResolveSession(sessionId: string, port: MessagePort) {
  const session = activeSessions.get(sessionId);
  if (session && typeof session.node.size === 'number') {
    safePost(port, { type: 'session-info', found: true, ...sessionInfo(session) });
  } else {
    safePost(port, { type: 'session-info', found: false });
  }
  safeClose(port);
}

// The CDN rejected the download URL (expired); mint a new one.
async function handleRefreshUrl(sessionId: string, port: MessagePort) {
  const session = activeSessions.get(sessionId);
  let url: string | null = null;
  if (session) {
    try {
      url = await fetchDownloadUrl(session.node);
    } catch (err) {
      console.warn('Refreshing MEGA download URL failed:', err);
    }
    if (url && session.direct) session.direct.url = url;
  }
  safePost(port, { type: 'url', url });
  safeClose(port);
}

// --- Fallback: page-side megajs download ----------------------------------

const RANGE_RETRIES = 3;

function handleFetchRange(req: FetchRangeMessage, port: MessagePort) {
  const session = activeSessions.get(req.sessionId);
  if (!session) {
    safePost(port, { type: 'error', message: 'Session not found' });
    safeClose(port);
    return;
  }

  // A single transient MEGA hiccup used to kill the whole <video> element
  // (fatal demuxer read error), so failed range downloads are resumed from
  // the last delivered byte a few times before giving up.
  let cancelled = false;
  let sent = 0;
  let attempts = 0;
  let stream: any = null;
  let retryTimer: number | undefined;
  let sourcePaused = false;

  port.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'cancel') {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      try { stream?.destroy?.(); } catch (_) {}
      safeClose(port);
    } else if (msg.type === 'pause') {
      // The consumer's queue is full. megajs hands back a Node-style stream,
      // so pausing stops the MEGA transfer rather than piling the rest of the
      // window up in the page.
      sourcePaused = true;
      try { stream?.pause?.(); } catch (_) {}
    } else if (msg.type === 'resume') {
      sourcePaused = false;
      try { stream?.resume?.(); } catch (_) {}
    }
  };

  const fail = (err: any) => {
    showStreamErrorToast('Streaming failed', err);
    safePost(port, { type: 'error', message: err?.message || 'megajs stream error' });
    safeClose(port);
  };

  const startStream = () => {
    if (cancelled) return;
    try {
      // maxConnections: 1 is the only megajs path that streams the response
      // body as it arrives (the multi-connection path buffers each whole
      // chunk before emitting it, and never aborts in-flight chunks on
      // destroy). One CDN connection is plenty for video bitrates.
      stream = session.node.download({
        start: req.start + sent,
        end: req.end,
        maxConnections: 1,
      });
    } catch (err: any) {
      fail(err);
      return;
    }

    // A retry that lands while the consumer is still full must not start
    // pouring data again.
    if (sourcePaused) {
      try { stream.pause?.(); } catch (_) {}
    }

    stream.on('data', (chunk: Uint8Array) => {
      if (cancelled) return;
      const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as any);
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      sent += copy.byteLength;
      try {
        port.postMessage({ type: 'chunk', chunk: copy.buffer }, [copy.buffer]);
      } catch (_) {
        cancelled = true;
        try { stream.destroy?.(); } catch (_) {}
      }
    });

    stream.on('end', () => {
      if (cancelled) return;
      safePost(port, { type: 'end' });
      safeClose(port);
    });

    stream.on('error', (err: Error) => {
      if (cancelled) return;
      try { stream.destroy?.(); } catch (_) {}
      attempts++;
      if (attempts <= RANGE_RETRIES) {
        console.warn(
          `Range ${req.start}-${req.end} failed at +${sent} (attempt ${attempts}/${RANGE_RETRIES}), retrying:`,
          err?.message || err
        );
        retryTimer = window.setTimeout(startStream, 1000 * attempts);
        return;
      }
      fail(err);
    });
  };

  startStream();
}

function safePost(port: MessagePort, msg: unknown) {
  try { port.postMessage(msg); } catch (_) {}
}

function safeClose(port: MessagePort) {
  try { port.close(); } catch (_) {}
}

function getMimeType(name: string): string {
  const ext = name.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    ogg: 'video/ogg',
    ogv: 'video/ogg',
  };
  return map[ext] || 'application/octet-stream';
}

export async function createStreamUrl(
  node: MegaFileLike,
  // Kept for callers; the service worker streams over a single CDN connection
  // now, so the connection count no longer applies.
  _opts: { maxConnections?: number } = {}
): Promise<{ url: string; cleanup: () => void }> {
  await ensureServiceWorker();
  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    throw new Error('Service Worker is not controlling this page. Try reloading.');
  }
  if (typeof node.size !== 'number') {
    throw new Error('File size is unknown — cannot start ranged stream');
  }

  const sessionId = (crypto as any).randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const session: SessionEntry = { node, direct: await buildDirectInfo(node) };
  activeSessions.set(sessionId, session);
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      try { channel.port1.close(); } catch (_) {}
      reject(new Error('Service Worker did not acknowledge session registration'));
    }, 5000);
    channel.port1.onmessage = (e) => {
      if (e.data && e.data.type === 'session-registered') {
        clearTimeout(timer);
        try { channel.port1.close(); } catch (_) {}
        resolve();
      }
    };
    controller.postMessage({
      type: 'register-session',
      sessionId,
      ...sessionInfo(session),
    }, [channel.port2]);
  });

  return {
    url: `${import.meta.env.BASE_URL}__mega_stream/${sessionId}`,
    cleanup: () => {
      activeSessions.delete(sessionId);
      navigator.serviceWorker.controller?.postMessage({
        type: 'unregister-session',
        sessionId,
      });
    },
  };
}
