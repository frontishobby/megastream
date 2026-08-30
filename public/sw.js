const SCOPE_PATH = new URL(self.registration.scope).pathname;
const STREAM_PATH = SCOPE_PATH + '__mega_stream/';
const sessions = new Map();

// An open-ended `bytes=N-` used to be answered with "N through end of file", so
// every seek made the page pull the whole remainder off MEGA — gigabytes of
// transfer and memory for a few seconds of playback. Answering with a short
// window is an ordinary 206; the browser just asks for the next one.
//
// Since then the pause/resume backpressure below caps what's actually in
// flight, so the window no longer protects memory — but every window boundary
// restarts the megajs stream (a fresh MEGA `g` API roundtrip plus chunk
// ramp-up), and on high-RTT mobile links those restarts drain the playback
// buffer. Hence a much larger window than the original 8 MB.
const MAX_WINDOW = 64 * 1024 * 1024;

// The <video> element stops *reading* a response once its buffer is full but
// keeps the connection open, so the queue has to push back on the page rather
// than accept chunks forever.
const STREAM_HIGH_WATER = 4 * 1024 * 1024;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'register-session') {
    sessions.set(data.sessionId, {
      size: data.size,
      mimeType: data.mimeType,
      clientId: event.source && event.source.id,
    });
    const port = event.ports && event.ports[0];
    if (port) {
      try { port.postMessage({ type: 'session-registered' }); } catch (_) {}
      try { port.close(); } catch (_) {}
    }
  } else if (data.type === 'unregister-session') {
    sessions.delete(data.sessionId);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(STREAM_PATH)) return;
  const sessionId = url.pathname.slice(STREAM_PATH.length);
  event.respondWith((async () => {
    // The browser terminates idle service workers, wiping the in-memory
    // session map mid-playback; the page still holds the session, so ask
    // open clients to re-register before giving up with a 404.
    let session = sessions.get(sessionId);
    if (!session) session = await resolveSessionFromClients(sessionId);
    if (!session) return new Response('Unknown session', { status: 404 });
    return handleStreamRequest(event.request, sessionId, session, url);
  })());
});

async function resolveSessionFromClients(sessionId) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    const info = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        try { channel.port1.close(); } catch (_) {}
        resolve(null);
      }, 2000);
      channel.port1.onmessage = (e) => {
        clearTimeout(timer);
        try { channel.port1.close(); } catch (_) {}
        const d = e.data;
        resolve(d && d.type === 'session-info' && d.found ? d : null);
      };
      try {
        client.postMessage({ type: 'resolve-session', sessionId }, [channel.port2]);
      } catch (_) {
        clearTimeout(timer);
        resolve(null);
      }
    });
    if (info) {
      const session = { size: info.size, mimeType: info.mimeType, clientId: client.id };
      sessions.set(sessionId, session);
      return session;
    }
  }
  return null;
}

async function handleStreamRequest(request, sessionId, session, url) {
  const { size, mimeType, clientId } = session;
  const rangeHeader = request.headers.get('range');

  let start = 0;
  let end = size - 1;
  let status = 200;
  const headers = new Headers({
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });

  // ?download=1 turns a navigation to this URL into a file save: the
  // attachment disposition hands the response to the download manager
  // without leaving the page (StreamSaver-style).
  // A save is a genuine full-file transfer and must not be windowed.
  const isDownload = !!(url && url.searchParams.get('download') === '1');
  if (isDownload) {
    const name = url.searchParams.get('name') || 'download';
    headers.set(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    );
  }

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      start = parseInt(match[1], 10);
      if (match[2]) end = parseInt(match[2], 10);
      if (end >= size) end = size - 1;
      if (start > end || start >= size) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        });
      }
      status = 206;
    }
  }

  // A GET with no Range header asks for the whole resource, and Chrome's media
  // loader sends one once playback settles — answering it in full puts the
  // full-file transfer straight back. Windowing it into a 206 keeps it bounded
  // and the loader simply asks for the next slice. HEAD has to keep describing
  // the whole resource, and a save is a real full-file transfer.
  const windowed = !isDownload && request.method !== 'HEAD';
  if (windowed && end - start + 1 > MAX_WINDOW) {
    end = start + MAX_WINDOW - 1;
    status = 206;
  }

  if (status === 206) {
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }

  headers.set('Content-Length', String(end - start + 1));

  if (request.method === 'HEAD') {
    return new Response(null, { status, headers });
  }

  let client = clientId ? await self.clients.get(clientId) : null;
  if (!client) {
    const all = await self.clients.matchAll({ type: 'window' });
    client = all[0] || null;
  }
  if (!client) {
    return new Response('No client available', { status: 410 });
  }

  const stream = createClientPullStream(client, sessionId, start, end);
  return new Response(stream, { status, headers });
}

function createClientPullStream(client, sessionId, start, end) {
  let port;
  let settled = false;
  let paused = false;
  return new ReadableStream({
    start(controller) {
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (e) => {
        const msg = e.data;
        if (!msg || settled) return;
        if (msg.type === 'chunk') {
          try {
            controller.enqueue(new Uint8Array(msg.chunk));
          } catch (_) {}
          // desiredSize counts bytes here (ByteLengthQueuingStrategy below).
          if (!paused && controller.desiredSize !== null && controller.desiredSize <= 0) {
            paused = true;
            try { port.postMessage({ type: 'pause' }); } catch (_) {}
          }
        } else if (msg.type === 'end') {
          settled = true;
          try { controller.close(); } catch (_) {}
          try { port.close(); } catch (_) {}
        } else if (msg.type === 'error') {
          settled = true;
          try { controller.error(new Error(msg.message || 'Stream error')); } catch (_) {}
          try { port.close(); } catch (_) {}
        }
      };
      client.postMessage(
        { type: 'fetch-range', sessionId, start, end },
        [channel.port2]
      );
    },
    pull(controller) {
      if (paused && controller.desiredSize !== null && controller.desiredSize > 0) {
        paused = false;
        try { port && port.postMessage({ type: 'resume' }); } catch (_) {}
      }
    },
    cancel() {
      settled = true;
      // The page closes the port once it has torn its megajs stream down;
      // closing it here can drop the cancel and leave the download running.
      try { port && port.postMessage({ type: 'cancel' }); } catch (_) {}
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: STREAM_HIGH_WATER }));
}
