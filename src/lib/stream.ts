interface MegaFileLike {
  size: number;
  name: string;
  download(opts: { start: number; end: number; maxConnections?: number }): any;
}

interface FetchRangeMessage {
  type: 'fetch-range';
  sessionId: string;
  start: number;
  end: number;
}

const activeSessions = new Map<string, MegaFileLike>();
let swReadyPromise: Promise<void> | null = null;
let messageHandlerInstalled = false;

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
    if (!data || data.type !== 'fetch-range') return;
    const port = event.ports[0];
    if (!port) return;
    handleFetchRange(data as FetchRangeMessage, port);
  });
}

function handleFetchRange(req: FetchRangeMessage, port: MessagePort) {
  const node = activeSessions.get(req.sessionId);
  if (!node) {
    safePost(port, { type: 'error', message: 'Session not found' });
    safeClose(port);
    return;
  }

  let stream: any;
  try {
    stream = node.download({ start: req.start, end: req.end, maxConnections: 4 });
  } catch (err: any) {
    safePost(port, { type: 'error', message: err?.message || String(err) });
    safeClose(port);
    return;
  }

  let cancelled = false;
  port.onmessage = (e) => {
    if (e.data && e.data.type === 'cancel') {
      cancelled = true;
      try { stream.destroy?.(); } catch (_) {}
      safeClose(port);
    }
  };

  stream.on('data', (chunk: Uint8Array) => {
    if (cancelled) return;
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as any);
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
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
    safePost(port, { type: 'error', message: err?.message || 'megajs stream error' });
    safeClose(port);
  });
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

export async function createStreamUrl(node: MegaFileLike): Promise<{ url: string; cleanup: () => void }> {
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

  activeSessions.set(sessionId, node);
  controller.postMessage({
    type: 'register-session',
    sessionId,
    size: node.size,
    mimeType: getMimeType(node.name),
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
