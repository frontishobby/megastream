const STREAM_PATH = '/__mega_stream/';
const sessions = new Map();

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
  } else if (data.type === 'unregister-session') {
    sessions.delete(data.sessionId);
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(STREAM_PATH)) return;
  const sessionId = url.pathname.slice(STREAM_PATH.length);
  const session = sessions.get(sessionId);
  if (!session) {
    event.respondWith(new Response('Unknown session', { status: 404 }));
    return;
  }
  event.respondWith(handleStreamRequest(event.request, sessionId, session));
});

async function handleStreamRequest(request, sessionId, session) {
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
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    }
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
    cancel() {
      settled = true;
      try { port && port.postMessage({ type: 'cancel' }); } catch (_) {}
      try { port && port.close(); } catch (_) {}
    },
  });
}
