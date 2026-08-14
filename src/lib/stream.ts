import { showStreamErrorToast } from './toast.svelte';

interface MegaFileLike {
  // megajs types size/name as optional; createStreamUrl rejects at runtime if
  // the size is absent
  size?: number;
  name?: string | null;
  download(opts: { start: number; end: number; maxConnections?: number }): any;
}

interface FetchRangeMessage {
  type: 'fetch-range';
  sessionId: string;
  start: number;
  end: number;
}

interface SessionEntry {
  node: MegaFileLike;
  maxConnections: number;
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
    const port = event.ports[0];
    if (!port) return;
    if (data.type === 'fetch-range') {
      handleFetchRange(data as FetchRangeMessage, port);
    } else if (data.type === 'resolve-session') {
      handleResolveSession(data.sessionId, port);
    }
  });
}

// A restarted service worker (idle-killed, empty session map) asks pages to
// re-register sessions so playback continues instead of 404ing mid-stream.
function handleResolveSession(sessionId: string, port: MessagePort) {
  const session = activeSessions.get(sessionId);
  if (session && typeof session.node.size === 'number') {
    safePost(port, {
      type: 'session-info',
      found: true,
      size: session.node.size,
      mimeType: getMimeType(session.node.name || ''),
    });
  } else {
    safePost(port, { type: 'session-info', found: false });
  }
  safeClose(port);
}

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

  port.onmessage = (e) => {
    if (e.data && e.data.type === 'cancel') {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      try { stream?.destroy?.(); } catch (_) {}
      safeClose(port);
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
      stream = session.node.download({
        start: req.start + sent,
        end: req.end,
        maxConnections: session.maxConnections,
      });
    } catch (err: any) {
      fail(err);
      return;
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
  opts: { maxConnections?: number } = {}
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

  activeSessions.set(sessionId, { node, maxConnections: opts.maxConnections ?? 4 });
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
      size: node.size,
      mimeType: getMimeType(node.name || ''),
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
